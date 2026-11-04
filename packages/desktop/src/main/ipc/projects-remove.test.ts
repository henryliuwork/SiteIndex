import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectCatalog } from "../project-catalog.js";
import { createSettingsStore } from "../settings-store.js";
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
});
