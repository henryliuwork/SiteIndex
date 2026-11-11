import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathsForProject } from "@siteindex/core";
import { isValidMediaSkuRecoveryPartition } from "@siteindex/shared";
import {
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

const roots: string[] = [];

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
  readonly pid = 45678;
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
  await writeFile(
    lockPath,
    JSON.stringify({
      device_id: settings().device_id,
      device_name: settings().device_name,
      pid: child.pid,
      job,
      started_at: "2026-10-23T01:00:00.000Z",
      heartbeat: "2026-10-23T01:00:00.000Z",
    }),
    "utf8",
  );
  return lockPath;
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

  it("redacts authorization material from utilityProcess progress and finished results", async () => {
    const projectPath = await projectDirectory();
    const child = new FakeUtilityProcess();
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
    const child = new FakeUtilityProcess();
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
        runId: "2026-10-23-media",
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
        runId: "2026-10-23-media",
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
      },
    });

    await expect(finished).resolves.toMatchObject({ runId, status: "partial" });
    const exposed = `${JSON.stringify(progress.mock.calls)} ${JSON.stringify(await finished)}`;
    expect(exposed).not.toContain(credential.applicationPassword);
    expect(exposed).not.toContain(basicToken);
    expect(exposed).toContain("sku-a1");
    expect(exposed).toContain('"reason":"[已隐藏]"');
    expect(progress.mock.calls[0]?.[0].projectPath).toBe(projectPath);
    expect(progress.mock.calls[0]?.[0].message).toBe("Uploading [已隐藏] ([已隐藏]); rejected account [已隐藏]");
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
    const progress: JobProgress[] = [];
    const finished: JobResult[] = [];
    const manager = createJobManager({
      workerPath: "job-worker.js",
      getSettings: async () => settings(),
      isMediaJobReady: () => true,
      getWordPressCredential: async (_id, projectPath) => credentialByPath.get(projectPath) ?? null,
      resolveProject: async (id) => (id === projectAId ? projectA : projectB),
      fork: () => {
        const child = new FakeUtilityProcess(true, "2026-10-23-media");
        childProcesses.push(child);
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
        runId: "2026-10-23-media-a",
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
        runId: "2026-10-23-media-b",
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
        run_id: "2026-10-23-media",
        job: "media",
        status: "failed",
        media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
        media_unknown_skus: ["fixture-sku-a", "fixture-sku-b"],
      },
    ]);
    expect(historyB).toMatchObject([
      {
        run_id: "2026-10-23-media",
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

  it("preserves verified media recovery rows and marks only the remaining SKUs unknown after a crash", async () => {
    const projectPath = await projectDirectory("workspace");
    const projectId = path.basename(projectPath) as ProjectId;
    const projectPaths = pathsFor("workspace");
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
        started_at: "2026-10-23T01:00:00.000Z",
        finished_at: "2026-10-23T01:05:00.000Z",
        status: "partial",
        media_requested_skus: ["fixture-confirmed", "fixture-unknown", "fixture-not-started"],
        media_batch_state: "outcome_unknown",
        media_results: [{ sku: "fixture-confirmed", status: "uploaded", image_url: "https://cdn.fixture.test/a.jpg" }],
        media_unknown_skus: ["fixture-unknown"],
        media_not_started_skus: ["fixture-not-started"],
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
      media_results: [{ sku: "fixture-confirmed", status: "uploaded", image_url: "https://cdn.fixture.test/a.jpg" }],
      media_unknown_skus: ["fixture-unknown"],
      media_not_started_skus: ["fixture-not-started"],
    });
    const history = await manager.history(projectId);
    expect(history[0]).toMatchObject({
      status: "failed",
      media_results: [{ sku: "fixture-confirmed", status: "uploaded", image_url: "https://cdn.fixture.test/a.jpg" }],
      media_unknown_skus: ["fixture-unknown"],
      media_not_started_skus: ["fixture-not-started"],
    });
    expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(history[0])).toBe(true);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
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
      { run_id: "2026-10-23-daily", status: "failed", errors: ["用户已取消任务。"] },
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
