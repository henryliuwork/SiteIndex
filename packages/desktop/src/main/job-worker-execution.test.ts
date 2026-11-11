import { createCoreService, type CoreService, type CoreServiceContext } from "@siteindex/core";
import { EventEmitter } from "node:events";
import {
  pathsFor,
  type AppSettings,
  type JobRequest,
  type JobProgress,
  type JobResult,
  type ProgressReporter,
  type ProjectId,
} from "@siteindex/shared";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobWorkerMessage, JobWorkerStartMessage } from "./job-protocol.js";
import { createJobManager, type UtilityProcessLike } from "./job-manager.js";
import {
  executeJobWorkerMessage,
  type JobWorkerExecutionDependencies,
  type JobWorkerMessagePort,
} from "./job-worker-execution.js";

const roots: string[] = [];

function request(projectPath: string): JobWorkerStartMessage {
  return {
    type: "run",
    request: { projectPath, job: "media", trigger: "manual", skus: ["fixture-sku-a", "fixture-sku-b"] },
    context: {
      deviceId: "fixture-device",
      deviceName: "Fixture Device",
      cacheDir: path.join(path.dirname(projectPath), "cache"),
      wordpressCredential: { username: "fixture-user", applicationPassword: "fixture-password" },
    },
  };
}

async function tempProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-worker-media-"));
  roots.push(root);
  return path.join(root, "project");
}

class WorkerConnectedProcess extends EventEmitter implements UtilityProcessLike {
  readonly pid = 12345;
  killed = false;

  constructor(private readonly dependencies: JobWorkerExecutionDependencies) {
    super();
  }

  postMessage(value: unknown): void {
    void executeJobWorkerMessage(
      value as JobWorkerStartMessage,
      { postMessage: (message: JobWorkerMessage) => this.emit("message", message) } satisfies JobWorkerMessagePort,
      this.dependencies,
    );
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }

  ready(): void {
    this.emit("message", { type: "ready" });
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("media utility worker Core execution ID", () => {
  it("uses one Core ID for started, progress, and result messages", async () => {
    const projectPath = await tempProject();
    const messages: JobWorkerMessage[] = [];
    const coreRunId = "media-fixture-core-id";
    const startedAt = "2026-11-12T10:00:00.000Z";
    const result: JobResult = {
      runId: coreRunId,
      job: "media",
      status: "partial",
      exitCode: 1,
      summary: "合成媒体任务完成",
      media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_batch_state: "outcome_unknown",
      media_results: [],
      media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_not_started_skus: [],
    };
    const contextSeen: CoreServiceContext[] = [];

    await executeJobWorkerMessage(
      request(projectPath),
      { postMessage: (message) => messages.push(message) },
      {
        createCore: (context) => {
          contextSeen.push(context);
          return {
            runJob: async (_job: JobRequest, report: ProgressReporter) => {
              context.onJobStarted?.(coreRunId, startedAt);
              report({ pct: 50, step: "media", level: "info", message: "处理中" });
              return result;
            },
          } as unknown as CoreService;
        },
        now: () => new Date(startedAt),
      },
    );

    expect(contextSeen[0]?.onJobStarted).toBeTypeOf("function");
    expect(messages.map(({ type }) => type)).toEqual(["started", "progress", "finished"]);
    expect(messages[0]).toEqual({ type: "started", runId: coreRunId, startedAt });
    expect(messages[1]).toMatchObject({ type: "progress", progress: { runId: coreRunId, job: "media" } });
    expect(messages[2]).toMatchObject({ type: "finished", result: { runId: coreRunId, job: "media" } });
    expect(JSON.stringify(messages)).not.toContain("fixture-password");
  });

  it("forwards Core's ID before a real Core config read fails", async () => {
    const projectPath = await tempProject();
    const paths = pathsFor("legacy");
    await mkdir(path.dirname(path.join(projectPath, paths.site)), { recursive: true });
    await writeFile(path.join(projectPath, paths.site), "{ invalid config", "utf8");
    const messages: JobWorkerMessage[] = [];

    await executeJobWorkerMessage(
      request(projectPath),
      { postMessage: (message) => messages.push(message) },
      {
        createCore: (context) => createCoreService(context),
      },
    );

    expect(messages[0]).toMatchObject({ type: "started", runId: expect.stringMatching(/^media-/u) });
    expect(messages[1]).toMatchObject({ type: "finished", result: { job: "media", status: "failed" } });
    const started = messages.find((message) => message.type === "started");
    const finished = messages.find((message) => message.type === "finished");
    if (!started || !finished) throw new Error("Expected media start and result messages.");
    expect(finished.result.runId).toBe(started.runId);
    expect(finished.result.media_not_started_skus).toEqual(["fixture-sku-a", "fixture-sku-b"]);
    expect(JSON.stringify(messages)).not.toContain("fixture-password");
    await expect(readFile(path.join(projectPath, paths.runs), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the existing Desktop-generated business-date ID flow for non-media jobs", async () => {
    const projectPath = await tempProject();
    const messages: JobWorkerMessage[] = [];
    const coreResult: JobResult = {
      runId: "2026-11-12-weekly",
      job: "weekly",
      status: "ok",
      exitCode: 0,
      summary: "每周同步完成",
    };
    const nonMediaRequest: JobWorkerStartMessage = {
      type: "run",
      request: { projectPath, job: "weekly", trigger: "manual" },
      context: {
        deviceId: "fixture-device",
        deviceName: "Fixture Device",
        cacheDir: path.join(path.dirname(projectPath), "cache"),
      },
    };
    const progress: JobProgress = {
      runId: "ignored-core-id",
      projectPath,
      job: "weekly",
      pct: 50,
      level: "info",
      message: "同步中",
      at: "ignored",
    };

    await executeJobWorkerMessage(
      nonMediaRequest,
      { postMessage: (message) => messages.push(message) },
      {
        createCore: (context) => {
          expect(context.onJobStarted).toBeUndefined();
          return {
            runJob: async (_job: JobRequest, report: ProgressReporter) => {
              report(progress);
              return coreResult;
            },
          } as unknown as CoreService;
        },
        resolveRunId: async () => "2026-11-12-weekly",
        now: () => new Date("2026-11-12T10:00:00.000Z"),
      },
    );

    expect(messages.map(({ type }) => type)).toEqual(["started", "progress", "finished"]);
    expect(messages[0]).toMatchObject({ type: "started", runId: "2026-11-12-weekly" });
    expect(messages[1]).toMatchObject({ type: "progress", progress: { runId: "2026-11-12-weekly" } });
    expect(messages[2]).toMatchObject({ type: "finished", result: { runId: "2026-11-12-weekly" } });
  });

  it("fails closed instead of inventing a media ID when Core omits onJobStarted", async () => {
    const projectPath = await tempProject();
    const messages: JobWorkerMessage[] = [];
    const result: JobResult = {
      runId: "media-core-result-only",
      job: "media",
      status: "partial",
      exitCode: 1,
      summary: "不应被接受",
      media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_batch_state: "outcome_unknown",
      media_results: [],
      media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_not_started_skus: [],
    };

    await executeJobWorkerMessage(
      request(projectPath),
      { postMessage: (message) => messages.push(message) },
      {
        createCore: () => ({ runJob: async () => result }) as unknown as CoreService,
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "fatal", message: expect.stringContaining("未生成替代 ID") });
  });

  it("rejects a result whose ID differs from the Core started event", async () => {
    const projectPath = await tempProject();
    const messages: JobWorkerMessage[] = [];
    const result: JobResult = {
      runId: "media-other-core-id",
      job: "media",
      status: "partial",
      exitCode: 1,
      summary: "不应被接受",
      media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_batch_state: "outcome_unknown",
      media_results: [],
      media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_not_started_skus: [],
    };

    await executeJobWorkerMessage(
      request(projectPath),
      { postMessage: (message) => messages.push(message) },
      {
        createCore: (context) =>
          ({
            runJob: async () => {
              context.onJobStarted?.("media-started-core-id", "2026-11-12T10:00:00.000Z");
              return result;
            },
          }) as unknown as CoreService,
      },
    );

    expect(messages.map(({ type }) => type)).toEqual(["started", "fatal"]);
    expect(messages[1]).toMatchObject({ type: "fatal", message: expect.stringContaining("ID 与启动 ID 不一致") });
  });

  it("uses the Core ID for a failure thrown after the Core start event", async () => {
    const projectPath = await tempProject();
    const messages: JobWorkerMessage[] = [];
    const coreRunId = "media-started-before-error";

    await executeJobWorkerMessage(
      request(projectPath),
      { postMessage: (message) => messages.push(message) },
      {
        createCore: (context) =>
          ({
            runJob: async () => {
              context.onJobStarted?.(coreRunId, "2026-11-12T10:00:00.000Z");
              throw new Error("synthetic worker failure");
            },
          }) as unknown as CoreService,
      },
    );

    expect(messages.map(({ type }) => type)).toEqual(["started", "finished"]);
    expect(messages[1]).toMatchObject({ type: "finished", result: { runId: coreRunId, status: "failed" } });
  });

  it("lets JobManager finalize a Core exception after started through the worker message path", async () => {
    const projectPath = await tempProject();
    const projectId = path.basename(projectPath) as ProjectId;
    const projectPaths = pathsFor("legacy");
    await mkdir(path.join(projectPath, projectPaths.index), { recursive: true });
    await writeFile(path.join(projectPath, projectPaths.site), JSON.stringify({ timezone: "UTC" }), "utf8");
    const coreRunId = "media-core-started-before-throw";
    const appSettings: AppSettings = {
      device_id: "fixture-device",
      device_name: "Fixture Device",
      projects_root: "",
      extra_projects: [],
      cache_dir: path.join(path.dirname(projectPath), "cache"),
      browser: { channel: "msedge", executable_path: null },
      notify: { on_failure: false, on_success: false, oos_threshold: null, dingtalk_webhook: null },
      skill_platforms: [],
      conflict_patterns: [],
    };
    const child = new WorkerConnectedProcess({
      createCore: (context) =>
        ({
          runJob: async () => {
            context.onJobStarted?.(coreRunId, "2026-11-12T10:00:00.000Z");
            throw new Error("synthetic Core failure after start");
          },
        }) as unknown as CoreService,
    });
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => appSettings,
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: () => undefined,
      emitFinished: resolveFinished,
      notify: () => undefined,
    });

    const started = await manager.runMedia({ projectPath, job: "media", skus: ["fixture-sku-a", "fixture-sku-b"] });
    expect(started.runId).toBe(coreRunId);
    const result = await finished;

    expect(result).toMatchObject({
      runId: coreRunId,
      job: "media",
      status: "failed",
      media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_batch_state: "outcome_unknown",
      media_results: [],
      media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_not_started_skus: [],
    });
    await expect.poll(() => manager.activeCount).toBe(0);
    expect(manager.running(projectId)).toBeNull();
    expect(child.killed).toBe(true);
  });
});
