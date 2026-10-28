import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings, type JobProgress, type JobResult, type ProjectId } from "@siteindex/shared";
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
  killed = false;

  constructor(private readonly reportStarted = true) {
    super();
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (!this.reportStarted) return;
    queueMicrotask(() => {
      this.emit("message", { type: "started", runId: "2026-10-23-daily", startedAt: "2026-10-23T01:00:00.000Z" });
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

async function projectDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-job-manager-"));
  roots.push(root);
  await mkdir(path.join(root, PATHS.index), { recursive: true });
  await writeFile(path.join(root, PATHS.site), JSON.stringify({ timezone: "UTC" }), "utf8");
  return root;
}

async function writeOwnedLock(projectPath: string, child: FakeUtilityProcess, job: string): Promise<string> {
  const lockPath = path.join(projectPath, PATHS.lock);
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
    const lockPath = path.join(projectPath, PATHS.lock);
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
    await manager.pauseAndWaitForIdle();
    provideSettings(settings());
    await expect(starting).rejects.toMatchObject({ code: "LOCKED" });
    expect(fork).not.toHaveBeenCalled();
  });
});
