import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectCatalog } from "../project-catalog.js";
import { createSettingsStore } from "../settings-store.js";
import { createScheduleReconciliationQueue } from "../scheduler/reconciliation-queue.js";
import { createProjectsHandlers } from "./projects.js";
import type { IpcContext } from "./context.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function fixture(kind: "root" | "extra", authorizationRequired = false) {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-remove-"));
  const projectsRoot = path.join(root, "projects");
  const projectPath = path.join(kind === "root" ? projectsRoot : path.join(root, "external"), "fictional");
  await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
  await writeFile(path.join(projectPath, PATHS.site), "{}\n");
  await writeFile(path.join(projectPath, PATHS.readme), "# Fictional\n");
  const settings = createSettingsStore(path.join(root, "settings"));
  await settings.set({ projects_root: projectsRoot, extra_projects: kind === "extra" ? [projectPath] : [] });
  const projects = createProjectCatalog(
    () => undefined,
    () => undefined,
  );
  await projects.refresh(await settings.get());
  cleanup.push(async () => {
    await projects.close();
    await rm(root, { recursive: true, force: true });
  });

  const tasks = new Set(["fictional-daily"]);
  const reconcileSchedules = vi.fn(async () => {
    if (!authorizationRequired) tasks.clear();
    return { mode: "system" as const, authorization_required: authorizationRequired };
  });
  const settingsChanged = vi.fn(async (_updated: AppSettings, _reconcile: boolean) => undefined);
  const context = {
    settings,
    projects,
    settingsChanged,
    reconcileSchedules,
    core: { projects: { get: vi.fn(async () => ({ summary: { id: "fictional" } })) } },
    withProject: async <T>(id: string, run: (id: string) => Promise<T>) => {
      await projects.ensureProject(id, await settings.get());
      return run(id);
    },
  } as unknown as IpcContext;
  return {
    projectPath,
    settings,
    projects,
    tasks,
    reconcileSchedules,
    settingsChanged,
    handlers: createProjectsHandlers(context),
  };
}

describe("projects.remove Desktop flow", () => {
  it.each(["root", "extra"] as const)("unregisters a %s project and restores it when added again", async (kind) => {
    const { projectPath, settings, projects, tasks, reconcileSchedules, handlers } = await fixture(kind);
    const canonicalPath = projects.resolveProject("fictional");
    await expect(handlers["projects.remove"]?.("fictional")).resolves.toBeUndefined();
    expect(tasks.size).toBe(0);
    expect(reconcileSchedules).toHaveBeenCalledOnce();
    expect(reconcileSchedules).toHaveBeenCalledWith(true, undefined, undefined, ["fictional"]);
    expect(await projects.refresh(await settings.get())).toEqual([]);
    expect(await readFile(path.join(projectPath, PATHS.site), "utf8")).toBe("{}\n");
    if (kind === "root") expect((await settings.get()).hidden_projects).toContain(canonicalPath);
    else expect((await settings.get()).extra_projects).toEqual([]);

    await expect(handlers["projects.addExisting"]?.(projectPath)).resolves.toMatchObject({ id: "fictional" });
    expect((await projects.refresh(await settings.get())).map(({ id }) => id)).toEqual(["fictional"]);
    expect((await settings.get()).hidden_projects).not.toContain(projectPath);
    expect(reconcileSchedules).toHaveBeenCalledTimes(2);
  });

  it("keeps the project removed and reports task cleanup authorization failure", async () => {
    const { settings, projects, tasks, handlers } = await fixture("root", true);
    await expect(handlers["projects.remove"]?.("fictional")).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("项目已取消登记"),
    });
    expect(await projects.refresh(await settings.get())).toEqual([]);
    expect(tasks.has("fictional-daily")).toBe(true);
  });

  it("re-adds the same project after failed removal cleanup and restores its task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-remove-readd-recovery-"));
    const projectsRoot = path.join(root, "projects");
    const projectPath = path.join(projectsRoot, "fictional");
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    await writeFile(path.join(projectPath, PATHS.site), "{}\n");
    await writeFile(path.join(projectPath, PATHS.readme), "# Fictional\n");
    const settings = createSettingsStore(path.join(root, "settings"));
    await settings.set({ projects_root: projectsRoot });
    const projects = createProjectCatalog(
      () => undefined,
      () => undefined,
    );
    await projects.refresh(await settings.get());
    cleanup.push(async () => {
      await projects.close();
      await rm(root, { recursive: true, force: true });
    });

    const taskQueue = createScheduleReconciliationQueue();
    const tasks = new Set(["fictional-daily"]);
    let signalRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      signalRemovalStarted = resolve;
    });
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let signalBackgroundStarted!: () => void;
    const backgroundStarted = new Promise<void>((resolve) => {
      signalBackgroundStarted = resolve;
    });
    let backgroundRan = false;
    const reconcileSchedules = vi.fn(
      (_allowElevation: boolean, _entries?: unknown, _onTiming?: unknown, removedProjectIds?: string[]) =>
        taskQueue.enqueue(async () => {
          if (removedProjectIds?.includes("fictional")) {
            signalRemovalStarted();
            await removalGate;
            tasks.delete("fictional-daily");
            throw new Error("simulated partial task cleanup failure");
          }
          const entries = await projects.refresh(await settings.get());
          if (entries.some(({ id }) => id === "fictional")) tasks.add("fictional-daily");
          else tasks.delete("fictional-daily");
          return { mode: "system" as const, authorization_required: false };
        }),
    );
    const reconcileProjectScheduleInBackground = vi.fn((projectId: string) => {
      void taskQueue
        .enqueueForProject(projectId, async () => {
          backgroundRan = true;
          signalBackgroundStarted();
          const entries = await projects.refresh(await settings.get());
          if (entries.some(({ id }) => id === projectId)) tasks.add(`${projectId}-daily`);
          else tasks.delete(`${projectId}-daily`);
        })
        .catch(() => undefined);
    });
    const context = {
      settings,
      projects,
      settingsChanged: vi.fn(async () => undefined),
      reconcileSchedules,
      reconcileProjectScheduleInBackground,
      core: { projects: { get: vi.fn(async (id: string) => ({ summary: { id } })) } },
      withProject: async <T>(id: string, run: (id: string) => Promise<T>) => {
        await projects.ensureProject(id, await settings.get());
        return run(id);
      },
    } as unknown as IpcContext;
    const handlers = createProjectsHandlers(context);

    const removal = handlers["projects.remove"]!("fictional");
    await removalStarted;
    let added: unknown;
    try {
      added = await handlers["projects.addExisting"]!(projectPath);
    } finally {
      releaseRemoval();
    }

    expect(added).toMatchObject({ id: "fictional" });
    expect(backgroundRan).toBe(false);
    await expect(removal).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("注销系统计划任务失败"),
    });
    await backgroundStarted;
    await taskQueue.waitForProject("fictional");

    expect((await projects.refresh(await settings.get())).map(({ id }) => id)).toEqual(["fictional"]);
    expect(tasks.has("fictional-daily")).toBe(true);
    expect(reconcileProjectScheduleInBackground).toHaveBeenCalledWith("fictional");
    expect(reconcileSchedules).toHaveBeenCalledWith(true, undefined, undefined, ["fictional"]);
  });
});
