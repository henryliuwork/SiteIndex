import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings, type JobResult, type ProjectId } from "@siteindex/shared";
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

  postMessage(message: unknown): void {
    this.messages.push(message);
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
    await writeFile(
      lockPath,
      JSON.stringify({
        device_id: settings().device_id,
        device_name: settings().device_name,
        pid: child.pid,
        job: "daily",
        started_at: "2026-10-23T01:00:00.000Z",
        heartbeat: "2026-10-23T01:00:00.000Z",
      }),
      "utf8",
    );

    await manager.cancel(runId);

    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.history(path.basename(projectPath) as ProjectId)).resolves.toMatchObject([
      { run_id: "2026-10-23-daily", status: "failed", errors: ["用户已取消任务。"] },
    ]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ runId, status: "failed", exitCode: 3 });
  });
});
