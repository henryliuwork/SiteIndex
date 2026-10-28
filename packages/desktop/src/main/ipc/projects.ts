import path from "node:path";
import { writeRunner } from "@siteindex/core";
import type { AppSettings, SiteIndexError } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { isProjectInsideRoot } from "../project-catalog.js";
import type { IpcContext } from "./context.js";

export function createProjectsHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "projects.list": async () => {
      const entries = await context.projects.refresh(await context.settings.get());
      return Promise.all(entries.map(async ({ id }) => (await context.core.projects.get(id)).summary));
    },
    "projects.get": (id) => context.withProject(id, (projectId) => context.core.projects.get(projectId)),
    "projects.detect": (...args) => context.core.projects.detect(args[0] as string),
    "projects.inspectFeed": (...args) =>
      context.core.projects.inspectFeed(args[0] as string[], args[1] as { sku_field: string; category_depth: number }),
    "projects.create": async (...args) => {
      const input = args[0] as Parameters<typeof context.core.projects.create>[0];
      const created = await context.core.projects.create(input);
      const projectPath = path.resolve(input.projects_root, created.id);
      const current = await context.settings.get();
      let updated = current;
      if (!isProjectInsideRoot(current.projects_root, projectPath)) {
        const paths = new Set(current.extra_projects.map((entry) => path.resolve(entry)));
        paths.add(projectPath);
        updated = await context.settings.set({ extra_projects: [...paths] });
        await context.settingsChanged(updated, false);
      }
      await context.projects.refresh(updated);
      const registeredPath = context.projects.resolveProject(created.id);
      await writeRunner(registeredPath, {
        device_id: updated.device_id,
        device_name: updated.device_name,
        claimed_at: new Date().toISOString(),
      });
      context.core.invalidate(registeredPath);
      const { runId } = await context.jobs.run({ projectPath: registeredPath, job: "init" });
      return { id: created.id, runId };
    },
    "projects.addExisting": async (value) => {
      if (typeof value !== "string") {
        throw { code: "PROJECT_NOT_FOUND", message: "请选择有效的项目目录。" } satisfies SiteIndexError;
      }
      const projectPath = await context.projects.resolveExistingPath(value);
      const current = await context.settings.get();
      let updated: AppSettings = current;
      if (!isProjectInsideRoot(current.projects_root, projectPath)) {
        const paths = new Set(current.extra_projects.map((entry) => path.resolve(entry)));
        paths.add(projectPath);
        updated = await context.settings.set({ extra_projects: [...paths] });
        await context.settingsChanged(updated);
      } else {
        await context.projects.refresh(current);
      }
      const id = path.basename(projectPath);
      await context.projects.ensureProject(id, updated);
      await context.reconcileSchedules(true);
      return (await context.core.projects.get(id)).summary;
    },
    "projects.updateConfig": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.projects.updateConfig(id, args[1] as Parameters<typeof context.core.projects.updateConfig>[1]),
      ),
  };
}
