import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pathsForProject, readJsonl, withLock } from "@siteindex/core";
import { withLockForTest } from "../../../core/src/io/runner-lock.js";
import { isValidMediaSkuRecoveryPartition } from "@siteindex/shared";
import {
  EXIT,
  pathsFor,
  type AppSettings,
  type JobProgress,
  type JobResult,
  type ProjectId,
  type ProjectLayout,
  type ProjectPaths,
} from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobManager, type UtilityProcessLike } from "./job-manager.js";
import { resolveJobRunId } from "./job-run-id.js";

const roots: string[] = [];
type LockSubprocess = ChildProcessByStdio<null, Readable, Readable>;
const coreDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../core");
const coreRequire = createRequire(path.join(coreDirectory, "package.json"));
const coreRunnerUrl = pathToFileURL(path.join(coreDirectory, "src/index.ts")).href;
const tsxLoaderUrl = pathToFileURL(path.join(path.dirname(coreRequire.resolve("tsx/cli")), "loader.mjs")).href;

const coreLockSubprocessSource = `
import path from "node:path";
const { atomicWrite, pathsForProject, readJsonl, withLock } = await import(${JSON.stringify(coreRunnerUrl)});
const projectPath = process.argv[2];
const mode = process.argv[3];
const options = { deviceId: "desktop-test-device", deviceName: "Desktop Test", job: "lock-subprocess-test" };
if (mode === "hold") {
  await withLock(projectPath, async () => {
    process.stdout.write("HELD\\n");
    await new Promise(() => setInterval(() => undefined, 1000));
  }, options);
} else if (mode === "try") {
  try {
    await withLock(projectPath, async () => undefined, options);
    process.stdout.write("ACQUIRED\\n");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "LOCKED") {
      process.stdout.write("BLOCKED\\n");
    } else {
      process.stdout.write("UNEXPECTED\\n");
      process.exitCode = 2;
    }
  }
} else if (mode === "append") {
  await withLock(projectPath, async () => {
    const projectPaths = await pathsForProject(projectPath);
    const runsPath = path.join(projectPath, projectPaths.runs);
    const rows = await readJsonl(runsPath);
    rows.push({
      run_id: "2026-11-12-weekly-next",
      job: "weekly",
      trigger: "manual",
      started_at: "2026-11-12T10:02:00.000Z",
      finished_at: "2026-11-12T10:03:00.000Z",
      status: "failed",
    });
    await atomicWrite(runsPath, rows.map((row) => JSON.stringify(row)).join("\\n") + "\\n");
  }, options);
  process.stdout.write("APPENDED\\n");
} else {
  process.stdout.write("INVALID\\n");
  process.exitCode = 2;
}
`;

function coreMediaRunId(): string {
  return `2026-11-11-media-${randomUUID()}`;
}

function settings(): AppSettings {
  return {
    device_id: "desktop-test-device",
    device_name: "Desktop Test",
    projects_root: "",
    extra_projects: [],
    cache_dir: "C:/SiteIndex/cache",
    browser: { channel: "msedge", executable_path: "C:/Browser/msedge.exe" },
    notify: { on_failure: true, on_success: false, oos_threshold: 0.12, dingtalk_webhook: null },
    skill_platforms: [],
    conflict_patterns: [],
  };
}

class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  readonly pid = 2_147_000_000;
  readonly messages: unknown[] = [];
  readonly postedReferences: unknown[] = [];
  killed = false;

  constructor(
    private readonly reportStarted = true,
    private readonly reportedRunId = "2026-10-23-daily",
  ) {
    super();
  }

  postMessage(message: unknown): void {
    this.messages.push(structuredClone(message));
    this.postedReferences.push(message);
    if (!this.reportStarted) return;
    queueMicrotask(() => {
      this.emit("message", {
        type: "started",
        runId: this.reportedRunId,
        startedAt: "2026-10-23T01:00:00.000Z",
      });
    });
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 1));
    return true;
  }

  ready(): void {
    this.emit("message", { type: "ready" });
  }
}

async function projectDirectory(layout: ProjectLayout = "legacy"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-job-manager-"));
  roots.push(root);
  const projectPaths = pathsFor(layout);
  await mkdir(path.join(root, projectPaths.index), { recursive: true });
  await writeFile(path.join(root, projectPaths.site), JSON.stringify({ timezone: "UTC" }), "utf8");
  return root;
}

async function writeOwnedLock(projectPath: string, child: FakeUtilityProcess, job: string): Promise<string> {
  const projectPaths = await pathsForProject(projectPath);
  const lockPath = path.join(projectPath, projectPaths.lock);
  let hostId = "";
  await withLock(projectPath, async () => {
    const owned = JSON.parse(await readFile(lockPath, "utf8")) as { host_id?: unknown };
    if (typeof owned.host_id === "string") hostId = owned.host_id;
  }, { deviceId: settings().device_id, deviceName: settings().device_name, job: "read-test-host-id" });
  if (!hostId) throw new Error("Core test lock did not expose a host identity.");
  await writeFile(
    lockPath,
    JSON.stringify({
      device_id: settings().device_id,
      device_name: settings().device_name,
      host_id: hostId,
      pid: child.pid,
      job,
      started_at: "2026-10-23T01:00:00.000Z",
      heartbeat: "2026-10-23T01:00:00.000Z",
    }),
    "utf8",
  );
  return lockPath;
}

async function spawnCoreLockSubprocess(
  projectPath: string,
  mode: "hold" | "try" | "append",
): Promise<LockSubprocess> {
  const scriptPath = path.join(projectPath, ".synthetic-core-lock-subprocess.mts");
  await writeFile(scriptPath, coreLockSubprocessSource, "utf8");
  const child = spawn(process.execPath, ["--import", tsxLoaderUrl, scriptPath, projectPath, mode], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => undefined);
  return child;
}

async function waitForSubprocessMarker(child: LockSubprocess, marker: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Core lock subprocess timed out."));
    }, 20_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Core lock subprocess failed to start."));
    });
    child.once("exit", () => {
      if (output.includes(marker)) return;
      clearTimeout(timer);
      reject(new Error("Core lock subprocess exited before reporting its state."));
    });
  });
}

async function waitForSubprocessExit(child: LockSubprocess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return null;
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Core lock subprocess failed.")));
    child.once("exit", (code) => resolve(code));
  });
}

async function runIdPairForWorkerResultScenario(
  projectPath: string,
  scenario: "crosses-timezone-midnight" | "config-read-recovers",
): Promise<[string, string]> {
  const projectPaths = await pathsForProject(projectPath);
  const sitePath = path.join(projectPath, projectPaths.site);
  const request = { projectPath, job: "daily" as const };

  if (scenario === "crosses-timezone-midnight") {
    await writeFile(sitePath, JSON.stringify({ timezone: "America/Los_Angeles" }), "utf8");
    return [
      await resolveJobRunId(request, new Date("2026-11-11T07:59:59.999Z")),
      await resolveJobRunId(request, new Date("2026-11-11T08:00:00.001Z")),
    ];
  }

  await rm(sitePath, { force: true });
  const now = new Date("2026-11-11T01:00:00.000Z");
  const fallbackRunId = await resolveJobRunId(request, now);
  await writeFile(sitePath, JSON.stringify({ timezone: "America/Los_Angeles" }), "utf8");
  const recoveredRunId = await resolveJobRunId(request, now);
  return [fallbackRunId, recoveredRunId];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop job manager", () => {
  it("runs jobs in a utility process, forwards progress and limits each project to one job", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const progress = vi.fn();
    let finish!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolveFinished) => {
      finish = resolveFinished;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: progress,
      emitFinished: finish,
      notify: vi.fn(),
    });

    const start = manager.run({ projectPath, job: "daily" });
    const { runId } = await start;
    expect(child.messages[0]).toMatchObject({ context: { browserPath: "C:/Browser/msedge.exe" } });
    await expect(manager.run({ projectPath, job: "weekly" })).rejects.toMatchObject({ code: "LOCKED" });
    expect(runId).not.toBe("2026-10-23-daily");
    expect(manager.running(path.basename(projectPath) as ProjectId)).toEqual({ runId, job: "daily" });
    const lockPath = await writeOwnedLock(projectPath, child, "daily");

    child.emit("message", {
      type: "progress",
      progress: {
        runId: "2026-10-23-daily",
        projectPath,
        job: "daily",
        pct: 50,
        step: "daily",
        level: "info",
        message: "正在测试",
        at: "2026-10-23T01:00:01.000Z",
      },
    });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ runId }));

    child.emit("message", {
      type: "finished",
      result: {
        runId: "2026-10-23-daily",
        job: "daily",
        status: "ok",
        exitCode: 0,
        summary: "每日同步完成。",
      },
      oosRate: 0.2,
    });
    await expect(finished).resolves.toMatchObject({ runId, status: "ok" });
    expect(child.killed).toBe(true);
    expect(manager.activeCount).toBe(0);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses unique external run IDs for same-name jobs in different projects and cancels only the selected project", async () => {
    const projectA = await projectDirectory();
    const projectB = await projectDirectory();
    const projectIdA = path.basename(projectA) as ProjectId;
    const projectIdB = path.basename(projectB) as ProjectId;
    const children = [
      new FakeUtilityProcess(true, "2026-10-23-daily"),
      new FakeUtilityProcess(true, "2026-10-23-daily"),
    ];
    const spawnedChildren: FakeUtilityProcess[] = [];
    const projectPaths = new Map([
      [projectIdA, projectA],
      [projectIdB, projectB],
    ]);
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async (id) => {
        const project = projectPaths.get(id);
        if (!project) throw new Error("fixture project not found");
        return project;
      },
      fork: () => {
        const child = children.shift();
        if (!child) throw new Error("unexpected extra worker");
        spawnedChildren.push(child);
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const [runA, runB] = await Promise.all([
      manager.run({ projectPath: projectA, job: "daily" }),
      manager.run({ projectPath: projectB, job: "daily" }),
    ]);
    const childForProject = (projectPath: string) =>
      spawnedChildren.find((child) => {
        const message = child.messages[0] as { request?: { projectPath?: string } } | undefined;
        return message?.request?.projectPath === projectPath;
      });
    const childA = childForProject(projectA);
    const childB = childForProject(projectB);
    if (!childA || !childB) throw new Error("both project workers should have started");
    expect(runA.runId).not.toBe(runB.runId);
    expect(runA.runId).not.toBe("2026-10-23-daily");
    expect(runB.runId).not.toBe("2026-10-23-daily");
    await writeOwnedLock(projectA, childA, "daily");
    await writeOwnedLock(projectB, childB, "daily");

    await manager.cancel(runB.runId);

    expect(childB.killed).toBe(true);
    expect(childA.killed).toBe(false);
    expect(manager.running(projectIdA)).toEqual({ runId: runA.runId, job: "daily" });
    await expect(manager.history(projectIdB)).resolves.toMatchObject([{ run_id: runB.runId, status: "failed" }]);
    await manager.cancel(runA.runId);
    expect(childA.killed).toBe(true);
    await expect(manager.history(projectIdA)).resolves.toMatchObject([{ run_id: runA.runId, status: "failed" }]);
  });

  it.each(["crosses-timezone-midnight", "config-read-recovers"] as const)(
    "keeps a finished result attached to its worker when the Core business run ID %s",
    async (scenario) => {
      const projectPath = await projectDirectory();
      const projectId = path.basename(projectPath) as ProjectId;
      const [startedCoreRunId, finishedCoreRunId] = await runIdPairForWorkerResultScenario(projectPath, scenario);
      expect(startedCoreRunId).not.toBe(finishedCoreRunId);
      const child = new FakeUtilityProcess(true, startedCoreRunId);
      let resolveFinished!: (result: JobResult) => void;
      const finished = new Promise<JobResult>((resolve) => {
        resolveFinished = resolve;
      });
      const manager = createJobManager({
        workerPath: "job-worker.js",
        getSettings: async () => settings(),
        resolveProject: async () => projectPath,
        fork: () => {
          queueMicrotask(() => child.ready());
          return child;
        },
        emitProgress: vi.fn(),
        emitFinished: resolveFinished,
        notify: vi.fn(),
      });

      const { runId: externalRunId } = await manager.run({ projectPath, job: "daily" });
      child.emit("message", {
        type: "finished",
        result: {
          runId: finishedCoreRunId,
          job: "weekly",
          status: "ok",
          exitCode: 0,
          summary: "其他任务结果。",
        },
      });
      expect(manager.running(projectId)).toEqual({ runId: externalRunId, job: "daily" });
      expect(child.killed).toBe(false);
      child.emit("message", {
        type: "finished",
        result: {
          runId: finishedCoreRunId,
          job: "daily",
          status: "ok",
          exitCode: 0,
          summary: "每日任务完成。",
        },
      });

      await expect(finished).resolves.toMatchObject({ runId: externalRunId, status: "ok" });
      expect(externalRunId).not.toBe(startedCoreRunId);
      expect(externalRunId).not.toBe(finishedCoreRunId);
      expect(manager.running(projectId)).toBeNull();
    },
  );

  it("redacts authorization material from utilityProcess progress and finished results", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess(true, "2026-10-23-weekly");
    const progress = vi.fn();
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: progress,
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    await manager.run({ projectPath, job: "weekly" });
    const startMessage = JSON.stringify(child.messages[0]);
    expect(startMessage).not.toContain("fictional-user");
    expect(startMessage).not.toContain("fictional-password");
    expect(startMessage).not.toContain("ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk");
    child.emit("message", {
      type: "progress",
      progress: {
        runId: "2026-10-23-weekly",
        projectPath,
        job: "weekly",
        pct: null,
        level: "error",
        message:
          "Authorization: Bearer fictional-token; Authorization: Basic ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk",
        at: "2026-10-23T01:00:01.000Z",
      },
    });
    child.emit("message", {
      type: "finished",
      result: {
        runId: "2026-10-23-weekly",
        job: "weekly",
        status: "failed",
        exitCode: 1,
        summary: "请求 https://fictional-user:fictional-password@example.test 失败",
        errors: ["Authorization: Basic ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk"],
      },
    });

    await expect(finished).resolves.toMatchObject({ status: "failed" });
    expect(progress.mock.calls[0]?.[0].message).not.toContain("fictional-token");
    expect(progress.mock.calls[0]?.[0].message).not.toContain("ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk");
    const resultText = JSON.stringify(await finished);
    expect(resultText).not.toContain("fictional-user");
    expect(resultText).not.toContain("fictional-password");
    expect(resultText).not.toContain("ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk");
  });

  it("redacts utilityProcess fatal errors before rejecting a Desktop Job request", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess(false);
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const starting = manager.run({ projectPath, job: "weekly" });
    await vi.waitFor(() => expect(child.messages).toHaveLength(1));
    child.emit("message", {
      type: "fatal",
      message: "upload failed: Authorization: Basic ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk",
    });

    let detail = "";
    try {
      await starting;
    } catch (error) {
      detail = String(error && typeof error === "object" && "detail" in error ? error.detail : error);
    }
    expect(detail).not.toContain("ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk");
    expect(detail).toContain("[已隐藏]");
  });

  it("injects media credentials only through worker context and redacts every returned value", async () => {
    const projectPath = await projectDirectory();
    const startedCoreRunId = "2026-10-23-media";
    const child = new FakeUtilityProcess(true, startedCoreRunId);
    const credential = { username: "a", applicationPassword: "fictional-media-password" };
    const basicToken = Buffer.from(`${credential.username}:${credential.applicationPassword}`).toString("base64");
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const progress = vi.fn();
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => credential,
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: progress,
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    const untrustedRequest = { projectPath, job: "media" as const, skus: ["sku-a1"], credential };
    const { runId } = await manager.runMedia(untrustedRequest);
    expect(runId).toBe(startedCoreRunId);
    const startMessage = child.messages[0] as { request: Record<string, unknown>; context: Record<string, unknown> };
    expect(startMessage.request.skus).toEqual(["sku-a1"]);
    expect(JSON.stringify(startMessage.request)).not.toContain(credential.applicationPassword);
    expect(startMessage.context).toMatchObject({ wordpressCredential: credential });
    expect(
      (child.postedReferences[0] as { context: Record<string, unknown> }).context.wordpressCredential,
    ).toBeUndefined();

    child.emit("message", {
      type: "progress",
      progress: {
        runId: startedCoreRunId,
        projectPath,
        job: "media",
        pct: 50,
        level: "info",
        message: `Uploading ${credential.username}:${credential.applicationPassword} (${basicToken}); rejected account ${credential.username}`,
        at: "2026-10-23T01:00:01.000Z",
      },
    });
    child.emit("message", {
      type: "finished",
      oosRate: null,
      result: {
        runId: startedCoreRunId,
        job: "media",
        status: "partial",
        exitCode: 1,
        summary: `Completed ${credential.applicationPassword}`,
        errors: [basicToken],
        media_results: [{ sku: "sku-a1", status: "failed", reason: credential.username }],
        media_requested_skus: ["sku-a1"],
        media_batch_state: "complete",
        media_unknown_skus: [],
        media_not_started_skus: [],
        steps: [{ key: "media", status: "failed", message: "fixture-user fixture-password" }],
        credential_canary: "fixture-password",
      },
    });

    await expect(finished).resolves.toMatchObject({ runId, status: "partial" });
    const exposed = `${JSON.stringify(progress.mock.calls)} ${JSON.stringify(await finished)}`;
    expect(exposed).not.toContain(credential.applicationPassword);
    expect(exposed).not.toContain(basicToken);
    expect(exposed).not.toContain("fixture-password");
    expect(exposed).not.toContain("credential_canary");
    expect(exposed).toContain("sku-a1");
    expect(exposed).toContain('"reason":"[已隐藏]"');
    expect(progress.mock.calls[0]?.[0].projectPath).toBe(projectPath);
    expect(progress.mock.calls[0]?.[0].message).toBe("Uploading [已隐藏] ([已隐藏]); rejected account [已隐藏]");
  });

  it("keeps a Core media execution ID unchanged when the finished result arrives immediately after started", async () => {
    const projectPath = await projectDirectory();
    const startedCoreRunId = coreMediaRunId();
    const child = new FakeUtilityProcess(true, startedCoreRunId);
    const sku = "fixture-early-result";
    const progress = vi.fn();
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }),
      resolveProject: async () => projectPath,
      fork: () => {
        child.on("message", (message) => {
          if (!message || typeof message !== "object" || (message as { type?: string }).type !== "started") return;
          queueMicrotask(() => {
            child.emit("message", {
              type: "progress",
              progress: {
                runId: startedCoreRunId,
                projectPath,
                job: "media",
                pct: 100,
                level: "info",
                message: "媒体任务完成。",
                at: new Date().toISOString(),
              },
            });
            child.emit("message", {
              type: "finished",
              oosRate: null,
              result: {
                runId: startedCoreRunId,
                job: "media",
                status: "ok",
                exitCode: 0,
                summary: "媒体任务完成。",
                media_requested_skus: [sku],
                media_batch_state: "complete",
                media_results: [{ sku, status: "uploaded" }],
                media_unknown_skus: [],
                media_not_started_skus: [],
              },
            });
          });
        });
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: progress,
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    const start = manager.runMedia({ projectPath, job: "media", skus: [sku] });
    const { runId } = await start;
    const result = await finished;

    expect(runId).toBe(startedCoreRunId);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0]?.[0].runId).toBe(startedCoreRunId);
    expect(result.runId).toBe(startedCoreRunId);
    expect(result.media_results).toEqual([{ sku, status: "uploaded" }]);
    await vi.waitFor(() => expect(manager.activeCount).toBe(0));
  });

  it("rejects a duplicate active Core media execution ID without replacing the first project mapping", async () => {
    const projectA = await projectDirectory();
    const projectB = await projectDirectory();
    const projectIdA = path.basename(projectA) as ProjectId;
    const projectIdB = path.basename(projectB) as ProjectId;
    const duplicateRunId = coreMediaRunId();
    const children = [new FakeUtilityProcess(true, duplicateRunId), new FakeUtilityProcess(true, duplicateRunId)];
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }),
      resolveProject: async (projectId) => (projectId === projectIdA ? projectA : projectB),
      fork: () => {
        const child = children.shift();
        if (!child) throw new Error("unexpected extra worker");
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const first = await manager.runMedia({ projectPath: projectA, job: "media", skus: ["fixture-a"] });
    await expect(manager.runMedia({ projectPath: projectB, job: "media", skus: ["fixture-b"] })).rejects.toMatchObject({
      code: "UNKNOWN",
    });

    expect(manager.running(projectIdA)).toEqual({ runId: duplicateRunId, job: "media" });
    expect(manager.running(projectIdB)).toBeNull();
    expect(manager.activeCount).toBe(1);
    await manager.cancel(first.runId);
  });

  it("requires a stored WordPress credential before forking a media worker", async () => {
    const projectPath = await projectDirectory();
    const fork = vi.fn(() => new FakeUtilityProcess());
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => null,
      resolveProject: async () => projectPath,
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    await expect(manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] })).rejects.toMatchObject({
      code: "WP_NOT_CONFIGURED",
    });
    expect(fork).not.toHaveBeenCalled();
  });

  it("reports media as not implemented before reading credentials or forking until Core is ready", async () => {
    const projectPath = await projectDirectory();
    const getSettings = vi.fn(async () => settings());
    const getWordPressCredential = vi.fn(async () => ({
      username: "fictional-user",
      applicationPassword: "fictional-password",
    }));
    const fork = vi.fn(() => new FakeUtilityProcess());
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings,
      isMediaJobReady: () => false,
      getWordPressCredential,
      resolveProject: async () => projectPath,
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    await expect(manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(getWordPressCredential).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it("rejects an empty media SKU list before reading credentials or forking", async () => {
    const projectPath = await projectDirectory();
    const getWordPressCredential = vi.fn(async () => ({
      username: "fictional-user",
      applicationPassword: "fictional-password",
    }));
    const fork = vi.fn(() => new FakeUtilityProcess());
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential,
      resolveProject: async () => projectPath,
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    await expect(manager.runMedia({ projectPath, job: "media", skus: [] })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(getWordPressCredential).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it("reserves a project while media credentials are read so a concurrent start is rejected", async () => {
    const projectPath = await projectDirectory();
    const credentialRead = deferred<{
      username: string;
      applicationPassword: string;
    } | null>();
    const child = new FakeUtilityProcess();
    const fork = vi.fn(() => {
      queueMicrotask(() => child.ready());
      return child;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: () => credentialRead.promise,
      resolveProject: async () => projectPath,
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const firstStart = manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] });
    await vi.waitFor(() => expect(manager.activeCount).toBe(1));
    await expect(
      manager.runMedia({ projectPath, job: "media", skus: ["another-fictional-sku"] }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    expect(fork).not.toHaveBeenCalled();

    credentialRead.resolve({ username: "fictional-user", applicationPassword: "fictional-password" });
    const { runId } = await firstStart;
    expect(fork).toHaveBeenCalledTimes(1);
    await manager.cancel(runId);
  });

  it("waits for a pending credential read during update pause and prevents its worker from forking", async () => {
    const projectPath = await projectDirectory();
    const credentialRead = deferred<{
      username: string;
      applicationPassword: string;
    } | null>();
    const fork = vi.fn(() => new FakeUtilityProcess());
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: () => credentialRead.promise,
      resolveProject: async () => projectPath,
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const starting = manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] });
    await vi.waitFor(() => expect(manager.activeCount).toBe(1));
    let pauseFinished = false;
    const paused = manager.pauseAndWaitForIdle().then(() => {
      pauseFinished = true;
    });
    await Promise.resolve();
    expect(pauseFinished).toBe(false);
    expect(manager.activeCount).toBe(1);

    credentialRead.resolve({ username: "fictional-user", applicationPassword: "fictional-password" });
    await expect(starting).rejects.toMatchObject({ code: "LOCKED" });
    await paused;
    expect(fork).not.toHaveBeenCalled();
    expect(manager.activeCount).toBe(0);
  });

  it("releases a project start reservation after credential lookup fails", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const getWordPressCredential = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary vault failure"))
      .mockResolvedValue({ username: "fictional-user", applicationPassword: "fictional-password" });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential,
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    await expect(manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] })).rejects.toThrow(
      "temporary vault failure",
    );
    expect(manager.activeCount).toBe(0);

    const { runId } = await manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] });
    await manager.cancel(runId);
    expect(manager.activeCount).toBe(0);
  });

  it("redacts injected media credentials from fatal errors", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess(false);
    const credential = { username: "fictional-cancel-user", applicationPassword: "fictional-cancel-password" };
    const basicToken = Buffer.from(`${credential.username}:${credential.applicationPassword}`).toString("base64");
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => credential,
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const starting = manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] });
    await vi.waitFor(() => expect(child.messages).toHaveLength(1));
    child.emit("message", {
      type: "fatal",
      message: `connection failed ${credential.username}:${credential.applicationPassword} ${basicToken}`,
    });
    let detail = "";
    try {
      await starting;
    } catch (error) {
      detail = String(error && typeof error === "object" && "detail" in error ? error.detail : error);
    }
    expect(detail).not.toContain(credential.username);
    expect(detail).not.toContain(credential.applicationPassword);
    expect(detail).not.toContain(basicToken);
  });

  it("terminates a cancelled media worker and exposes only a sanitized cancellation result", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const credential = { username: "fictional-cancel-user", applicationPassword: "fictional-cancel-password" };
    let finished: JobResult | null = null;
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => credential,
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: (result) => {
        finished = result;
      },
      notify: vi.fn(),
    });

    const { runId } = await manager.runMedia({ projectPath, job: "media", skus: ["fictional-sku"] });
    await manager.cancel(runId);

    expect(child.killed).toBe(true);
    expect(manager.activeCount).toBe(0);
    expect(JSON.stringify(finished)).not.toContain(credential.username);
    expect(JSON.stringify(finished)).not.toContain(credential.applicationPassword);
  });

  it("isolates concurrent media jobs across legacy and workspace projects during app shutdown", async () => {
    const projectA = await projectDirectory("legacy");
    const projectB = await projectDirectory("workspace");
    const projectAId = path.basename(projectA) as ProjectId;
    const projectBId = path.basename(projectB) as ProjectId;
    const credentialA = { username: "fixture-user-a", applicationPassword: "fixture-password-a" };
    const credentialB = { username: "fixture-user-b", applicationPassword: "fixture-password-b" };
    const credentialByPath = new Map([
      [projectA, credentialA],
      [projectB, credentialB],
    ]);
    const childProcesses: FakeUtilityProcess[] = [];
    const coreRunIdByChild = new Map<FakeUtilityProcess, string>();
    const progress: JobProgress[] = [];
    const finished: JobResult[] = [];
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async (_id, projectPath) => credentialByPath.get(projectPath) ?? null,
      resolveProject: async (id) => (id === projectAId ? projectA : projectB),
      fork: () => {
        const coreRunId = coreMediaRunId();
        const child = new FakeUtilityProcess(true, coreRunId);
        childProcesses.push(child);
        coreRunIdByChild.set(child, coreRunId);
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: (event) => progress.push(event),
      emitFinished: (result) => finished.push(result),
      notify: vi.fn(),
    });

    const [runA, runB] = await Promise.all([
      manager.runMedia({
        projectPath: projectA,
        job: "media",
        skus: ["fixture-sku-a", "fixture-sku-a", "fixture-sku-b"],
      }),
      manager.runMedia({ projectPath: projectB, job: "media", skus: ["fixture-sku-b"] }),
    ]);
    const childForProject = (projectPath: string): FakeUtilityProcess | undefined =>
      childProcesses.find((child) => {
        const firstMessage = child.messages[0] as { request?: { projectPath?: string } } | undefined;
        return firstMessage?.request?.projectPath === projectPath;
      });
    const childA = childForProject(projectA);
    const childB = childForProject(projectB);
    if (!childA || !childB) throw new Error("media worker missing for fixture project");
    const coreRunIdA = coreRunIdByChild.get(childA);
    const coreRunIdB = coreRunIdByChild.get(childB);
    if (!coreRunIdA || !coreRunIdB) throw new Error("Core media execution ID missing for fixture project");

    expect(runA.runId).toBe(coreRunIdA);
    expect(runB.runId).toBe(coreRunIdB);
    expect(runA.runId).not.toBe(runB.runId);
    expect(childA.messages[0]).toMatchObject({ context: { wordpressCredential: credentialA } });
    expect(childB.messages[0]).toMatchObject({ context: { wordpressCredential: credentialB } });
    expect(childA.messages[0]).toMatchObject({ request: { skus: ["fixture-sku-a", "fixture-sku-b"] } });
    expect(manager.running(projectAId)).toEqual({ runId: runA.runId, job: "media" });
    expect(manager.running(projectBId)).toEqual({ runId: runB.runId, job: "media" });
    const [lockA, lockB] = await Promise.all([
      writeOwnedLock(projectA, childA, "media"),
      writeOwnedLock(projectB, childB, "media"),
    ]);

    childA.emit("message", {
      type: "progress",
      progress: {
        runId: coreRunIdA,
        projectPath: projectA,
        job: "media",
        pct: 50,
        level: "info",
        message: `${credentialA.username}:${credentialA.applicationPassword}`,
        at: "2026-10-23T01:00:01.000Z",
      },
    });
    childB.emit("message", {
      type: "progress",
      progress: {
        runId: coreRunIdB,
        projectPath: projectB,
        job: "media",
        pct: 50,
        level: "info",
        message: `${credentialB.username}:${credentialB.applicationPassword}`,
        at: "2026-10-23T01:00:02.000Z",
      },
    });
    expect(progress).toEqual([
      expect.objectContaining({ runId: runA.runId, projectPath: projectA, message: "[已隐藏]" }),
      expect.objectContaining({ runId: runB.runId, projectPath: projectB, message: "[已隐藏]" }),
    ]);

    await manager.shutdown();

    expect(manager.activeCount).toBe(0);
    expect(finished).toHaveLength(2);
    expect(finished).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: runA.runId,
          job: "media",
          status: "failed",
          errors: ["用户已取消任务。"],
        }),
        expect.objectContaining({
          runId: runB.runId,
          job: "media",
          status: "failed",
          errors: ["用户已取消任务。"],
        }),
      ]),
    );
    const recoveredA = finished.find((result) => result.runId === runA.runId);
    const recoveredB = finished.find((result) => result.runId === runB.runId);
    expect(recoveredA).toMatchObject({
      media_batch_state: "outcome_unknown",
      media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_results: [],
      media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      media_not_started_skus: [],
    });
    expect(recoveredB).toMatchObject({
      media_batch_state: "outcome_unknown",
      media_requested_skus: ["fixture-sku-b"],
      media_results: [],
      media_unknown_skus: ["fixture-sku-b"],
      media_not_started_skus: [],
    });
    expect(isValidMediaSkuRecoveryPartition(recoveredA)).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(recoveredB)).toBe(true);
    const [historyA, historyB] = await Promise.all([manager.history(projectAId), manager.history(projectBId)]);
    expect(historyA).toMatchObject([
      {
        run_id: runA.runId,
        job: "media",
        status: "failed",
        media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
        media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      },
    ]);
    expect(historyB).toMatchObject([
      {
        run_id: runB.runId,
        job: "media",
        status: "failed",
        media_requested_skus: ["fixture-sku-b"],
        media_unknown_skus: ["fixture-sku-b"],
      },
    ]);
    expect(isValidMediaSkuRecoveryPartition(historyA[0])).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(historyB[0])).toBe(true);
    await expect(access(lockA)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(lockB)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(projectB, pathsFor("legacy").runs))).rejects.toMatchObject({ code: "ENOENT" });
    const persisted = JSON.stringify({ historyA, historyB, progress, finished });
    expect(persisted).not.toContain(credentialA.username);
    expect(persisted).not.toContain(credentialA.applicationPassword);
    expect(persisted).not.toContain(credentialB.username);
    expect(persisted).not.toContain(credentialB.applicationPassword);
  });

  it("recovers a durable SKU partition after utilityProcess crash and exposes it in jobs.history", async () => {
    const projectPath = await projectDirectory("legacy");
    const projectId = path.basename(projectPath) as ProjectId;
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    let resolveFinished!: (result: JobResult) => void;
    const finishedPromise = new Promise<JobResult>((resolveFinishedValue) => {
      resolveFinished = resolveFinishedValue;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });
    const started = await manager.runMedia({
      projectPath,
      job: "media",
      skus: ["synthetic-a", "synthetic-b", "synthetic-c"],
    });
    expect(started.runId).toBe(runId);
    const projectPaths = pathsFor("legacy");
    const checkpointPath = path.join(projectPath, projectPaths.jobLogsDir, `${runId}.media.json`);
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, JSON.stringify({
      run_id: runId,
      checkpoint_state: "running",
      media_requested_skus: ["synthetic-a", "synthetic-b", "synthetic-c"],
      media_batch_state: "outcome_unknown",
      media_results: [{ sku: "synthetic-a", status: "uploaded", image_url: "https://cdn.example.test/media.jpg" }],
      media_unknown_skus: ["synthetic-b"],
      media_not_started_skus: ["synthetic-c"],
    }), "utf8");
    child.emit("exit", 1);

    const result = await finishedPromise;
    expect(result).toMatchObject({
      runId,
      job: "media",
      status: "failed",
      media_requested_skus: ["synthetic-a", "synthetic-b", "synthetic-c"],
      media_batch_state: "outcome_unknown",
      media_results: [{ sku: "synthetic-a", status: "uploaded", image_url: "https://cdn.example.test/media.jpg" }],
      media_unknown_skus: ["synthetic-b"],
      media_not_started_skus: ["synthetic-c"],
    });
    expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
    const [history] = await manager.history(projectId);
    expect(history).toMatchObject({
      run_id: runId,
      media_results: [{ sku: "synthetic-a", status: "uploaded" }],
      media_unknown_skus: ["synthetic-b"],
      media_not_started_skus: ["synthetic-c"],
    });
    expect(isValidMediaSkuRecoveryPartition(history)).toBe(true);
  });

  it.each([
    { label: "missing", mutation: null },
    { label: "corrupt", mutation: "not-json" },
    { label: "run ID mismatch", mutation: "run-id" },
    { label: "requested SKU order mismatch", mutation: "sku-order" },
  ] as const)("fails closed when the media checkpoint is $label", async ({ mutation }) => {
    const projectPath = await projectDirectory("legacy");
    const projectId = path.basename(projectPath) as ProjectId;
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });
    await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a", "synthetic-b"] });
    if (mutation) {
      const projectPaths = pathsFor("legacy");
      const checkpointPath = path.join(projectPath, projectPaths.jobLogsDir, `${runId}.media.json`);
      await mkdir(path.dirname(checkpointPath), { recursive: true });
      const validCheckpoint = {
        run_id: runId,
        checkpoint_state: "running",
        media_requested_skus: ["synthetic-a", "synthetic-b"],
        media_batch_state: "outcome_unknown",
        media_results: [],
        media_unknown_skus: ["synthetic-a", "synthetic-b"],
        media_not_started_skus: [],
      };
      const checkpoint = mutation === "run-id"
        ? { ...validCheckpoint, run_id: `media-${randomUUID()}` }
        : mutation === "sku-order"
          ? {
              ...validCheckpoint,
              media_requested_skus: ["synthetic-b", "synthetic-a"],
              media_unknown_skus: ["synthetic-b", "synthetic-a"],
            }
          : null;
      await writeFile(checkpointPath, checkpoint ? JSON.stringify(checkpoint) : "not-json", "utf8");
    }
    child.emit("exit", 1);

    const result = await finished;
    expect(result.status).toBe("failed");
    expect(result.media_requested_skus).toEqual(["synthetic-a", "synthetic-b"]);
    expect(result.media_results).toEqual([]);
    expect(result.media_unknown_skus).toEqual(["synthetic-a", "synthetic-b"]);
    expect(result.media_not_started_skus).toEqual([]);
    expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
    const [history] = await manager.history(projectId);
    if (!history) throw new Error("Recovered run history is missing.");
    expect(history.media_unknown_skus).toEqual(["synthetic-a", "synthetic-b"]);
    expect(isValidMediaSkuRecoveryPartition(history)).toBe(true);
  });

  it("does not replace a real successful media history row when the worker later exits", async () => {
    const projectPath = await projectDirectory("legacy");
    const projectId = path.basename(projectPath) as ProjectId;
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    const projectPaths = pathsFor("legacy");
    const runsPath = path.join(projectPath, projectPaths.runs);
    await mkdir(path.dirname(runsPath), { recursive: true });
    const successfulRow = {
      run_id: runId,
      job: "media",
      trigger: "manual",
      started_at: "2026-11-12T10:00:00.000Z",
      finished_at: "2026-11-12T10:01:00.000Z",
      status: "ok",
      media_requested_skus: ["synthetic-a"],
      media_batch_state: "complete",
      media_results: [{ sku: "synthetic-a", status: "uploaded" }],
      media_unknown_skus: [],
      media_not_started_skus: [],
    };
    const originalRuns = `${JSON.stringify(successfulRow)}\n`;
    await writeFile(runsPath, originalRuns, "utf8");
    const checkpointPath = path.join(projectPath, projectPaths.jobLogsDir, `${runId}.media.json`);
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeFile(
      checkpointPath,
      JSON.stringify({
        run_id: runId,
        checkpoint_state: "finished",
        media_requested_skus: ["synthetic-a"],
        media_batch_state: "complete",
        media_results: [{ sku: "synthetic-a", status: "uploaded" }],
        media_unknown_skus: [],
        media_not_started_skus: [],
      }),
      "utf8",
    );
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });
    await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a"] });
    child.emit("exit", 1);

    const currentCrash = await finished;
    expect(currentCrash).toMatchObject({
      runId,
      job: "media",
      status: "failed",
      exitCode: EXIT.SOURCE_FAILED,
      media_requested_skus: ["synthetic-a"],
      media_batch_state: "complete",
      media_results: [{ sku: "synthetic-a", status: "uploaded" }],
      media_unknown_skus: [],
    });
    expect(await readFile(runsPath, "utf8")).toBe(originalRuns);
    const [history] = await manager.history(projectId);
    if (!history) throw new Error("Existing successful run history is missing.");
    expect(history).toMatchObject(successfulRow);
    expect(isValidMediaSkuRecoveryPartition(history)).toBe(true);
  });

  it.each(["wrong-job", "wrong-requested-skus", "wrong-partition"] as const)(
    "preserves a same-run-ID media row that has %s and reports unknown for the current crash",
    async (mutation) => {
      const projectPath = await projectDirectory("legacy");
      const projectId = path.basename(projectPath) as ProjectId;
      const runId = `media-${randomUUID()}`;
      const child = new FakeUtilityProcess(true, runId);
      const projectPaths = pathsFor("legacy");
      const runsPath = path.join(projectPath, projectPaths.runs);
      await mkdir(path.dirname(runsPath), { recursive: true });
      const existingRow = mutation === "wrong-job"
        ? { run_id: runId, job: "weekly", started_at: "2026-11-12T10:00:00.000Z", finished_at: "2026-11-12T10:01:00.000Z", status: "failed" }
        : mutation === "wrong-requested-skus"
          ? {
              run_id: runId,
              job: "media",
              started_at: "2026-11-12T10:00:00.000Z",
              finished_at: "2026-11-12T10:01:00.000Z",
              status: "failed",
              media_requested_skus: ["other-a", "other-b"],
              media_batch_state: "outcome_unknown",
              media_results: [],
              media_unknown_skus: ["other-a", "other-b"],
              media_not_started_skus: [],
            }
          : {
              run_id: runId,
              job: "media",
              started_at: "2026-11-12T10:00:00.000Z",
              finished_at: "2026-11-12T10:01:00.000Z",
              status: "failed",
              media_requested_skus: ["synthetic-a", "synthetic-b"],
              media_batch_state: "outcome_unknown",
              media_results: [{ sku: "synthetic-a", status: "uploaded" }],
              media_unknown_skus: ["synthetic-b"],
              media_not_started_skus: [],
            };
      const originalRows = `${JSON.stringify(existingRow)}\n`;
      await writeFile(runsPath, originalRows, "utf8");
      let resolveFinished!: (result: JobResult) => void;
      const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
      const manager = createJobManager({
        workerPath: "job-worker.js",
        getSettings: async () => settings(),
        isMediaJobReady: () => true,
        getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
        resolveProject: async () => projectPath,
        fork: () => {
          queueMicrotask(() => child.ready());
          return child;
        },
        emitProgress: vi.fn(),
        emitFinished: resolveFinished,
        notify: vi.fn(),
      });
      await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a", "synthetic-b"] });
      child.emit("exit", 1);

      const result = await finished;
      expect(result).toMatchObject({
        status: "failed",
        media_requested_skus: ["synthetic-a", "synthetic-b"],
        media_batch_state: "outcome_unknown",
        media_results: [],
        media_unknown_skus: ["synthetic-a", "synthetic-b"],
        media_not_started_skus: [],
      });
      expect(await readFile(runsPath, "utf8")).toBe(originalRows);
      await expect(manager.history(projectId)).resolves.toMatchObject([existingRow]);
    },
  );

  it("takes over a dead Core lock and blocks a real competing withLock until history commits", async () => {
    const projectPath = await projectDirectory("legacy");
    const projectPaths = pathsFor("legacy");
    const runsPath = path.join(projectPath, projectPaths.runs);
    const lockPath = path.join(projectPath, projectPaths.lock);
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    const holder = await spawnCoreLockSubprocess(projectPath, "hold");
    await waitForSubprocessMarker(holder, "HELD");
    const originalLock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; job: string };
    expect(originalLock).toMatchObject({ pid: holder.pid, job: "lock-subprocess-test" });
    const holderExit = waitForSubprocessExit(holder);
    holder.kill();
    await holderExit;
    await expect(access(lockPath)).resolves.toBeUndefined();

    let signalHistoryCommit!: () => void;
    let releaseHistoryCommit!: () => void;
    const historyCommitEntered = new Promise<void>((resolve) => { signalHistoryCommit = resolve; });
    const historyCommitGate = new Promise<void>((resolve) => { releaseHistoryCommit = resolve; });
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
      testOnlyBeforeSyntheticRunLogCommit: async () => {
        signalHistoryCommit();
        await historyCommitGate;
      },
    });
    await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a"] });
    child.emit("exit", 1);
    await historyCommitEntered;
    await expect(access(lockPath)).resolves.toBeUndefined();
    const recoveryLock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; job: string };
    expect(recoveryLock).toMatchObject({ pid: process.pid, job: "desktop-media-recovery" });

    const competitor = await spawnCoreLockSubprocess(projectPath, "try");
    await waitForSubprocessMarker(competitor, "BLOCKED");
    await expect(waitForSubprocessExit(competitor)).resolves.toBe(0);

    releaseHistoryCommit();
    const recovered = await finished;
    expect(recovered.status).toBe("failed");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const nextRun = await spawnCoreLockSubprocess(projectPath, "append");
    await waitForSubprocessMarker(nextRun, "APPENDED");
    await expect(waitForSubprocessExit(nextRun)).resolves.toBe(0);
    const rows = await readJsonl(runsPath);
    expect(rows.map((row) => row.run_id).sort()).toEqual([runId, "2026-11-12-weekly-next"].sort());
  }, 30_000);

  it("uses the Core single-winner reclaim claim when Desktop races another stale-lock reclaimer", async () => {
    const projectPath = await projectDirectory("legacy");
    const guardProjectPath = await projectDirectory("legacy");
    const projectPaths = pathsFor("legacy");
    const lockPath = path.join(projectPath, projectPaths.lock);
    const runsPath = path.join(projectPath, projectPaths.runs);
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    const holder = await spawnCoreLockSubprocess(projectPath, "hold");
    await waitForSubprocessMarker(holder, "HELD");
    const holderExit = waitForSubprocessExit(holder);
    holder.kill();
    await holderExit;
    await expect(access(lockPath)).resolves.toBeUndefined();

    let signalClaimPublished!: () => void;
    let releaseClaim!: () => void;
    const claimPublished = new Promise<void>((resolve) => { signalClaimPublished = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let signalHistoryCommit!: () => void;
    let releaseHistoryCommit!: () => void;
    const historyCommitEntered = new Promise<void>((resolve) => { signalHistoryCommit = resolve; });
    const historyCommitGate = new Promise<void>((resolve) => { releaseHistoryCommit = resolve; });
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
      testOnlyBeforeSyntheticRunLogCommit: async () => {
        signalHistoryCommit();
        await historyCommitGate;
      },
    });
    await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-race"] });

    try {
      await withLockForTest(guardProjectPath, async () => {
        child.emit("exit", 1);
        await claimPublished;

        // Desktop has published the Core reclaim claim but has not yet replaced the stale lock.
        // A real second Core process now races the same stale generation and must be rejected.
        const competitor = await spawnCoreLockSubprocess(projectPath, "try");
        await waitForSubprocessMarker(competitor, "BLOCKED");
        await expect(waitForSubprocessExit(competitor)).resolves.toBe(0);

        releaseClaim();
        await historyCommitEntered;
        const recoveryLock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; job: string };
        expect(recoveryLock).toMatchObject({ pid: process.pid, job: "desktop-media-recovery" });
        releaseHistoryCommit();

        const result = await finished;
        expect(result).toMatchObject({
          status: "failed",
          media_batch_state: "outcome_unknown",
          media_requested_skus: ["synthetic-race"],
          media_unknown_skus: ["synthetic-race"],
        });
        await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        const rows = await readJsonl(runsPath);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ run_id: runId, job: "media", status: "failed" });

        const afterRecovery = await spawnCoreLockSubprocess(projectPath, "try");
        await waitForSubprocessMarker(afterRecovery, "ACQUIRED");
        await expect(waitForSubprocessExit(afterRecovery)).resolves.toBe(0);
      }, {
        deviceId: settings().device_id,
        deviceName: settings().device_name,
        job: "desktop-test-claim-scope",
      }, {
        afterReclaimClaimPublished: async () => {
          signalClaimPublished();
          await claimGate;
        },
      });
    } finally {
      releaseClaim();
      releaseHistoryCommit();
    }
  }, 30_000);

  it("creates a recovery lock when the worker exits before Core acquired its lock", async () => {
    const projectPath = await projectDirectory("legacy");
    const projectPaths = pathsFor("legacy");
    const lockPath = path.join(projectPath, projectPaths.lock);
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    let signalHistoryCommit!: () => void;
    let releaseHistoryCommit!: () => void;
    const historyCommitEntered = new Promise<void>((resolve) => { signalHistoryCommit = resolve; });
    const historyCommitGate = new Promise<void>((resolve) => { releaseHistoryCommit = resolve; });
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
      testOnlyBeforeSyntheticRunLogCommit: async () => {
        signalHistoryCommit();
        await historyCommitGate;
      },
    });
    await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a"] });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    child.emit("exit", 1);
    await historyCommitEntered;
    const recoveryLock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; job: string };
    expect(recoveryLock).toMatchObject({ pid: process.pid, job: "desktop-media-recovery" });
    const competitor = await spawnCoreLockSubprocess(projectPath, "try");
    await waitForSubprocessMarker(competitor, "BLOCKED");
    await expect(waitForSubprocessExit(competitor)).resolves.toBe(0);
    releaseHistoryCommit();
    expect((await finished).status).toBe("failed");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("leaves a third-party live Core lock and its history untouched", async () => {
    const projectPath = await projectDirectory("legacy");
    const projectPaths = pathsFor("legacy");
    const lockPath = path.join(projectPath, projectPaths.lock);
    const runsPath = path.join(projectPath, projectPaths.runs);
    const runId = `media-${randomUUID()}`;
    const child = new FakeUtilityProcess(true, runId);
    const holder = await spawnCoreLockSubprocess(projectPath, "hold");
    await waitForSubprocessMarker(holder, "HELD");
    const originalLock = await readFile(lockPath, "utf8");
    const originalHistory = `${JSON.stringify({
      run_id: runId,
      job: "weekly",
      started_at: "2026-11-12T10:00:00.000Z",
      finished_at: "2026-11-12T10:01:00.000Z",
      status: "failed",
    })}\n`;
    await mkdir(path.dirname(runsPath), { recursive: true });
    await writeFile(runsPath, originalHistory, "utf8");
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });
    try {
      await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a"] });
      child.emit("exit", 1);
      const result = await finished;
      expect(result).toMatchObject({ status: "failed", media_unknown_skus: ["synthetic-a"], media_results: [] });
      expect(result.summary).toContain("无法安全取得项目运行锁");
      expect(result.errors).toContain(
        "无法安全取得项目运行锁，原有历史保持不变；请人工检查项目锁、runs.jsonl 与媒体端实际状态后再重试。",
      );
      expect(result.errors?.join(" ")).not.toContain("历史与当前请求不匹配");
      expect(await readFile(lockPath, "utf8")).toBe(originalLock);
      expect(await readFile(runsPath, "utf8")).toBe(originalHistory);
    } finally {
      const holderExit = waitForSubprocessExit(holder);
      holder.kill();
      await holderExit;
    }
  }, 30_000);

  it.each([
    ["read", "读取 runs.jsonl 失败，原历史未修改；请人工检查运行记录与媒体端实际状态后再重试。"],
    ["write", "写入 runs.jsonl 失败，无法确认恢复历史是否已持久化；请人工检查运行记录与媒体端实际状态后再重试。"],
  ] as const)("keeps old history and reports an unknown result when synthetic run history %s fails", async (phase, expectedError) => {
    const projectPath = await projectDirectory("legacy");
    const projectPaths = pathsFor("legacy");
    const runsPath = path.join(projectPath, projectPaths.runs);
    const runId = `media-${randomUUID()}`;
    const originalHistory = `${JSON.stringify({
      run_id: "2026-11-12-weekly-before-media",
      job: "weekly",
      started_at: "2026-11-12T10:00:00.000Z",
      finished_at: "2026-11-12T10:01:00.000Z",
      status: "ok",
    })}\n`;
    await mkdir(path.dirname(runsPath), { recursive: true });
    await writeFile(runsPath, originalHistory, "utf8");

    const child = new FakeUtilityProcess(true, runId);
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => { resolveFinished = resolve; });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-secret" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
      ...(phase === "read"
        ? { testOnlyReadSyntheticRunLog: async () => { throw new Error("EACCES"); } }
        : { testOnlyWriteSyntheticRunLog: async () => { throw new Error("ENOSPC"); } }),
    });

    await manager.runMedia({ projectPath, job: "media", skus: ["synthetic-a"] });
    child.emit("exit", 1);
    const result = await finished;

    expect(result).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("恢复历史"),
      media_batch_state: "outcome_unknown",
      media_requested_skus: ["synthetic-a"],
      media_unknown_skus: ["synthetic-a"],
      media_results: [],
    });
    expect(result.errors).toContain(expectedError);
    expect(await readFile(runsPath, "utf8")).toBe(originalHistory);
  });

  it.each(["legacy", "workspace"] as const)(
    "reads persisted media recovery fields from the %s history and leaves old records unavailable",
    async (layout) => {
      const projectPath = await projectDirectory(layout);
      const projectId = path.basename(projectPath) as ProjectId;
      const projectPaths = pathsFor(layout);
      const runsPath = path.join(projectPath, projectPaths.runs);
      await mkdir(path.dirname(runsPath), { recursive: true });
      const currentRecord = {
        run_id: "2026-11-10-media-current",
        job: "media",
        started_at: "2026-11-10T10:00:00.000Z",
        finished_at: "2026-11-10T10:05:00.000Z",
        status: "partial",
        media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
        media_batch_state: "outcome_unknown",
        media_results: [{ sku: "fixture-sku-a", status: "uploaded", image_url: "https://cdn.fixture.test/a.jpg" }],
        media_unknown_skus: ["fixture-sku-b"],
        media_not_started_skus: [],
      };
      const oldRecord = {
        run_id: "2026-11-09-media-old",
        job: "media",
        started_at: "2026-11-09T10:00:00.000Z",
        finished_at: "2026-11-09T10:05:00.000Z",
        status: "failed",
      };
      await writeFile(runsPath, `${JSON.stringify(currentRecord)}\n${JSON.stringify(oldRecord)}\n`, "utf8");
      const manager = createJobManager({
        workerPath: "job-worker.js",
        getSettings: async () => settings(),
        resolveProject: async () => projectPath,
        fork: () => new FakeUtilityProcess(),
        emitProgress: vi.fn(),
        emitFinished: vi.fn(),
        notify: vi.fn(),
      });

      const history = await manager.history(projectId);
      expect(history[0]).toMatchObject(currentRecord);
      expect(isValidMediaSkuRecoveryPartition(history[0])).toBe(true);
      expect(history[1]).toMatchObject(oldRecord);
      expect(history[1]).not.toHaveProperty("media_requested_skus");
      expect(isValidMediaSkuRecoveryPartition(history[1])).toBe(false);
    },
  );

  it.each(["legacy", "workspace"] as const)(
    "records a crashed media worker in the %s project history without exposing credentials",
    async (layout) => {
      const projectPath = await projectDirectory(layout);
      const projectId = path.basename(projectPath) as ProjectId;
      const credential = { username: "fixture-crash-user", applicationPassword: "fixture-crash-password" };
      const child = new FakeUtilityProcess(true, "2026-10-23-media");
      let resolveFinished!: (result: JobResult) => void;
      const finished = new Promise<JobResult>((resolve) => {
        resolveFinished = resolve;
      });
      const manager = createJobManager({
        workerPath: "job-worker.js",
        getSettings: async () => settings(),
        isMediaJobReady: () => true,
        getWordPressCredential: async () => credential,
        resolveProject: async () => projectPath,
        fork: () => {
          queueMicrotask(() => child.ready());
          return child;
        },
        emitProgress: vi.fn(),
        emitFinished: resolveFinished,
        notify: vi.fn(),
      });

      const { runId } = await manager.runMedia({ projectPath, job: "media", skus: ["fixture-crash-sku"] });
      const lockPath = await writeOwnedLock(projectPath, child, "media");
      child.emit("exit", 17);

      const result = await finished;
      expect(result).toMatchObject({
        runId,
        job: "media",
        status: "failed",
        errors: ["utilityProcess exit code: 17"],
      });
      await vi.waitFor(() => expect(manager.activeCount).toBe(0));
      expect(manager.running(projectId)).toBeNull();
      const history = JSON.stringify(await manager.history(projectId));
      expect(history).toContain('"job":"media"');
      expect(history).toContain('"status":"failed"');
      const historyRows = await manager.history(projectId);
      expect(historyRows[0]).toMatchObject({
        media_batch_state: "outcome_unknown",
        media_requested_skus: ["fixture-crash-sku"],
        media_results: [],
        media_unknown_skus: ["fixture-crash-sku"],
        media_not_started_skus: [],
      });
      expect(isValidMediaSkuRecoveryPartition(historyRows[0])).toBe(true);
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(result)).not.toContain(credential.username);
      expect(JSON.stringify(result)).not.toContain(credential.applicationPassword);
      expect(history).not.toContain(credential.username);
      expect(history).not.toContain(credential.applicationPassword);
    },
  );

  it.each([
    { label: "underreports a SKU", reportedSkus: ["fixture-a"] },
    { label: "adds an unrequested SKU", reportedSkus: ["fixture-a", "fixture-b", "fixture-extra"] },
    { label: "reorders requested SKUs", reportedSkus: ["fixture-b", "fixture-a"] },
  ])("downgrades a media result that $label to outcome-unknown", async ({ reportedSkus }) => {
    const projectPath = await projectDirectory("workspace");
    const projectId = path.basename(projectPath) as ProjectId;
    const child = new FakeUtilityProcess();
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    await manager.runMedia({ projectPath, job: "media", skus: ["fixture-a", "fixture-a", "fixture-b"] });
    child.emit("message", {
      type: "finished",
      oosRate: null,
      result: {
        runId: "2026-11-10-media",
        job: "media",
        status: "ok",
        exitCode: 0,
        summary: "看似成功但请求 SKU 列表不匹配",
        media_requested_skus: reportedSkus,
        media_batch_state: "outcome_unknown",
        media_results: [],
        media_unknown_skus: reportedSkus,
        media_not_started_skus: [],
      },
    });
    child.emit("exit", 0);

    const result = await finished;
    await vi.waitFor(() => expect(manager.activeCount).toBe(0));
    expect(result).toMatchObject({
      job: "media",
      status: "failed",
      media_batch_state: "outcome_unknown",
      media_requested_skus: ["fixture-a", "fixture-b"],
      media_results: [],
      media_unknown_skus: ["fixture-a", "fixture-b"],
      media_not_started_skus: [],
    });
    expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
    expect(isValidMediaSkuRecoveryPartition((await manager.history(projectId))[0])).toBe(true);
  });

  it("keeps an older same-day checkpoint separate and does not attribute it to the crashed execution", async () => {
    const projectPath = await projectDirectory("workspace");
    const projectId = path.basename(projectPath) as ProjectId;
    const projectPaths = pathsFor("workspace");
    const child = new FakeUtilityProcess(true, coreMediaRunId());
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    await manager.runMedia({
      projectPath,
      job: "media",
      skus: ["fixture-confirmed", "fixture-unknown", "fixture-not-started"],
    });
    const runsPath = path.join(projectPath, projectPaths.runs);
    await mkdir(path.dirname(runsPath), { recursive: true });
    await writeFile(
      runsPath,
      `${JSON.stringify({
        run_id: "2026-10-23-media",
        job: "media",
        trigger: "manual",
        device_name: settings().device_name,
        started_at: "2026-10-23T00:30:00.000Z",
        finished_at: "2026-10-23T00:35:00.000Z",
        status: "partial",
        media_requested_skus: ["fixture-confirmed", "fixture-unknown", "fixture-not-started"],
        media_batch_state: "outcome_unknown",
        media_results: [
          {
            sku: "fixture-confirmed",
            status: "uploaded",
            reason: "Application password fixture-password",
            image_url: "https://cdn.fixture.test/a.jpg?user=fixture-user#fixture-password",
          },
        ],
        media_unknown_skus: ["fixture-unknown"],
        media_not_started_skus: ["fixture-not-started"],
        errors: ["fixture-user fixture-password"],
        steps: [{ key: "media", status: "failed", message: "fixture-user fixture-password" }],
        credential_canary: "fixture-password",
      })}\n`,
      "utf8",
    );
    const lockPath = await writeOwnedLock(projectPath, child, "media");
    child.emit("exit", 17);

    const result = await finished;
    await vi.waitFor(() => expect(manager.activeCount).toBe(0));
    expect(result).toMatchObject({
      status: "failed",
      media_batch_state: "outcome_unknown",
      media_requested_skus: ["fixture-confirmed", "fixture-unknown", "fixture-not-started"],
      media_results: [],
      media_unknown_skus: ["fixture-confirmed", "fixture-unknown", "fixture-not-started"],
      media_not_started_skus: [],
    });
    const history = await manager.history(projectId);
    expect(history[0]).toMatchObject({
      run_id: result.runId,
      status: "failed",
      media_results: [],
      media_unknown_skus: ["fixture-confirmed", "fixture-unknown", "fixture-not-started"],
      media_not_started_skus: [],
    });
    expect(history[1]).toMatchObject({
      run_id: "2026-10-23-media",
      media_results: [{ sku: "fixture-confirmed", status: "uploaded" }],
      media_unknown_skus: ["fixture-unknown"],
      media_not_started_skus: ["fixture-not-started"],
    });
    expect(JSON.stringify(history)).not.toContain("fixture-password");
    expect(JSON.stringify(history)).not.toContain("fixture-user");
    expect(JSON.stringify(history)).not.toContain("image_url");
    expect(JSON.stringify(history)).not.toContain("credential_canary");
    expect(history[1]).toMatchObject({ errors: ["媒体任务存在未公开的错误详情。"] });
    expect(history[1]).not.toHaveProperty("steps");
    expect(history[1]).not.toHaveProperty("credential_canary");
    expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(history[0])).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(history[1])).toBe(true);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts current media worker reasons and drops unsafe image URLs before forwarding", async () => {
    const projectPath = await projectDirectory("workspace");
    const child = new FakeUtilityProcess(true, "2026-10-23-media");
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    await manager.runMedia({ projectPath, job: "media", skus: ["fixture-safe", "fixture-unsafe"] });
    child.emit("message", {
      type: "finished",
      oosRate: null,
      result: {
        runId: "2026-10-23-media",
        job: "media",
        status: "partial",
        exitCode: 1,
        summary: "完成",
        media_requested_skus: ["fixture-safe", "fixture-unsafe"],
        media_batch_state: "complete",
        media_results: [
          { sku: "fixture-safe", status: "uploaded", reason: "saved", image_url: "https://cdn.fixture.test/safe.jpg" },
          {
            sku: "fixture-unsafe",
            status: "failed",
            reason: "Application password fixture-password",
            image_url: "https://cdn.fixture.test/unsafe.jpg?user=fixture-user#fixture-password",
          },
        ],
        media_unknown_skus: [],
        media_not_started_skus: [],
      },
    });

    const result = await finished;
    await vi.waitFor(() => expect(manager.activeCount).toBe(0));
    expect(result).toMatchObject({
      media_results: [
        { sku: "fixture-safe", status: "uploaded", image_url: "https://cdn.fixture.test/safe.jpg" },
        { sku: "fixture-unsafe", status: "failed" },
      ],
    });
    expect(result.media_results?.[1]).not.toHaveProperty("image_url");
    expect(JSON.stringify(result)).not.toContain("fixture-password");
    expect(JSON.stringify(result)).not.toContain("credential_canary");
    expect(result).not.toHaveProperty("credential_canary");
    expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
  });

  it("does not put worker fatal text into Desktop run history", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    await manager.run({ projectPath, job: "weekly" });
    child.emit("message", {
      type: "fatal",
      message: "upload failed: Authorization: Basic ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk",
    });

    await expect(finished).resolves.toMatchObject({ status: "failed" });
    const history = JSON.stringify(await manager.history(path.basename(projectPath) as ProjectId));
    expect(history).not.toContain("ZmljdGlvbmFsLXVzZXI6ZmljdGlvbmFsLXBhc3N3b3Jk");
  });

  it("cancels a process, releases its owned lock and records the cancellation", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const finished: JobResult[] = [];
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: (result) => finished.push(result),
      notify: vi.fn(),
    });

    const { runId } = await manager.run({ projectPath, job: "daily" });
    const projectPaths = await pathsForProject(projectPath);
    const lockPath = path.join(projectPath, projectPaths.lock);
    await writeOwnedLock(projectPath, child, "daily");

    await manager.cancel(runId);

    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.history(path.basename(projectPath) as ProjectId)).resolves.toMatchObject([
      { run_id: runId, status: "failed", errors: ["用户已取消任务。"] },
    ]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ runId, status: "failed", exitCode: 3 });
  });

  it("releases its owned lock when the utility process crashes after starting", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    let resolveFinished!: (result: JobResult) => void;
    const finished = new Promise<JobResult>((resolve) => {
      resolveFinished = resolve;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: resolveFinished,
      notify: vi.fn(),
    });

    await manager.run({ projectPath, job: "weekly" });
    const lockPath = await writeOwnedLock(projectPath, child, "weekly");
    child.emit("exit", 1);

    await expect(finished).resolves.toMatchObject({ job: "weekly", status: "failed" });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for lock cleanup before --run-job returns from runAndWait", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const running = manager.runAndWait({ projectPath, job: "weekly" }, "schedule");
    await vi.waitFor(() => expect(child.messages).toHaveLength(1));
    const lockPath = await writeOwnedLock(projectPath, child, "weekly");
    child.emit("message", {
      type: "finished",
      result: { runId: "2026-10-23-daily", job: "weekly", status: "ok", exitCode: 0, summary: "每周同步完成。" },
    });

    await expect(running).resolves.toMatchObject({ job: "weekly", status: "ok" });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases a worker lock even if the utility process exits before reporting its run id", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess(false);
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const starting = manager.run({ projectPath, job: "daily" });
    await vi.waitFor(() => expect(child.messages).toHaveLength(1));
    const lockPath = await writeOwnedLock(projectPath, child, "daily");
    child.emit("exit", 1);

    await expect(starting).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.activeCount).toBe(0);
  });
  it("delays init onFinished until Desktop schedule finalization and hides Core's schedule placeholder", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const progress = vi.fn();
    const finished = vi.fn();
    let resolveSchedule!: (value: JobResult) => void;
    const scheduleDone = new Promise<JobResult>((resolve) => {
      resolveSchedule = resolve;
    });
    const finalizeInit = vi.fn(async (result: JobResult, currentPath: string, emit: (event: JobProgress) => void) => {
      emit({
        runId: result.runId,
        projectPath: currentPath,
        job: "init",
        pct: 96,
        step: "schedule",
        level: "info",
        message: "正在注册",
        at: new Date().toISOString(),
      });
      return scheduleDone;
    });
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: progress,
      emitFinished: finished,
      finalizeInit,
      notify: vi.fn(),
    });
    const { runId } = await manager.run({ projectPath, job: "init" });
    child.emit("message", {
      type: "progress",
      progress: {
        runId: "2026-10-23-daily",
        projectPath,
        job: "init",
        pct: 100,
        step: "schedule",
        level: "info",
        message: "由桌面端注册",
        at: new Date().toISOString(),
      },
    });
    expect(progress).not.toHaveBeenCalled();
    child.emit("message", {
      type: "finished",
      result: { runId: "2026-10-23-daily", job: "init", status: "ok", exitCode: 0, summary: "核心步骤完成" },
    });
    await vi.waitFor(() => expect(finalizeInit).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ runId, step: "schedule", pct: 96 }));
    resolveSchedule({
      runId,
      job: "init",
      status: "ok",
      exitCode: 0,
      summary: "完成",
      steps: [{ key: "schedule", status: "ok" }],
    });
    await vi.waitFor(() =>
      expect(finished).toHaveBeenCalledWith(
        expect.objectContaining({ runId, steps: [{ key: "schedule", status: "ok" }] }),
      ),
    );
  });
  it("does not request schedule authorization after init is cancelled", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const finished = vi.fn();
    const finalizeInit = vi.fn();
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: finished,
      finalizeInit,
      notify: vi.fn(),
    });
    const { runId } = await manager.run({ projectPath, job: "init" });
    await manager.cancel(runId);
    expect(finalizeInit).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        steps: [{ key: "schedule", status: "skipped", message: "初始化已取消，未注册定时任务。" }],
      }),
    );
  });
  it("drains active Jobs and blocks new starts while an update installs", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      resolveProject: async () => projectPath,
      fork: () => {
        queueMicrotask(() => child.ready());
        return child;
      },
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    await manager.run({ projectPath, job: "daily" });
    let drained = false;
    const draining = manager.pauseAndWaitForIdle().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(manager.run({ projectPath, job: "weekly" })).rejects.toMatchObject({ code: "LOCKED" });

    child.emit("message", {
      type: "finished",
      result: { runId: "2026-10-23-daily", job: "daily", status: "ok", exitCode: 0, summary: "完成" },
    });
    await draining;
    expect(manager.activeCount).toBe(0);
    expect(drained).toBe(true);
    manager.resumeJobs();
  });
  it("does not start a Job that was still resolving settings when installation began", async () => {
    let provideSettings!: (value: AppSettings) => void;
    const pendingSettings = new Promise<AppSettings>((resolve) => {
      provideSettings = resolve;
    });
    const fork = vi.fn(() => new FakeUtilityProcess());
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: () => pendingSettings,
      resolveProject: async () => "unused",
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });

    const starting = manager.run({ projectPath: "pending-project", job: "daily" });
    const pausing = manager.pauseAndWaitForIdle();
    await Promise.resolve();
    expect(manager.activeCount).toBe(1);
    provideSettings(settings());
    await expect(starting).rejects.toMatchObject({ code: "LOCKED" });
    await pausing;
    expect(fork).not.toHaveBeenCalled();
    expect(manager.activeCount).toBe(0);
  });

  it.each(["pause", "shutdown"] as const)(
    "does not fork a Job when %s starts during project layout resolution",
    async (lifecycle) => {
      const projectPath = await projectDirectory();
      const pendingPaths = deferred<ProjectPaths>();
      const resolveProjectPaths = vi.fn(() => pendingPaths.promise);
      const fork = vi.fn(() => new FakeUtilityProcess());
      const manager = createJobManager({
        workerPath: "job-worker.js",
        getSettings: async () => settings(),
        resolveProject: async () => projectPath,
        resolveProjectPaths,
        fork,
        emitProgress: vi.fn(),
        emitFinished: vi.fn(),
        notify: vi.fn(),
      });

      const starting = manager.run({ projectPath, job: "daily" });
      await vi.waitFor(() => expect(resolveProjectPaths).toHaveBeenCalledOnce());
      const draining = lifecycle === "pause" ? manager.pauseAndWaitForIdle() : manager.shutdown();
      pendingPaths.resolve(pathsFor("legacy"));

      await expect(starting).rejects.toMatchObject({ code: "LOCKED" });
      await draining;
      expect(fork).not.toHaveBeenCalled();
      expect(manager.activeCount).toBe(0);
    },
  );
});
