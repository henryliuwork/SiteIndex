import path from "node:path";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { writeRunner } from "@siteindex/core";
import type { AppSettings, SiteIndexError } from "@siteindex/shared";
import type { AddExistingTiming, AddExistingTimingCallback } from "../add-existing-trace.js";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { isProjectInsideRoot } from "../project-catalog.js";
import type { IpcContext } from "./context.js";

export function createProjectsHandlers(context: IpcContext): IpcHandlerImplementations {
  // 项目创建、导入与取消登记共用队列，避免完整设置数组的并发写入互相覆盖。
  let projectMutationQueue: Promise<void> = Promise.resolve();
  const pathKey = async (value: string): Promise<string> => {
    const resolved = await realpath(value).catch(() => path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  function enqueueProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = projectMutationQueue.then(operation);
    projectMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    "projects.list": async () => {
      const entries = await context.projects.refresh(await context.settings.get());
      return Promise.all(entries.map(async ({ id }) => (await context.core.projects.get(id)).summary));
    },
    "projects.get": (id) => context.withProject(id, (projectId) => context.core.projects.get(projectId)),
    "projects.detect": (...args) => context.core.projects.detect(args[0] as string),
    "projects.inspectFeed": (...args) =>
      context.core.projects.inspectFeed(args[0] as string[], args[1] as { sku_field: string; category_depth: number }),
    "projects.create": (...args) =>
      enqueueProjectMutation(async () => {
        const input = args[0] as Parameters<typeof context.core.projects.create>[0];
        const created = await context.core.projects.create(input);
        const projectPath = path.resolve(input.projects_root, created.id);
        const current = await context.settings.get();
        let updated = current;
        if (!(await isProjectInsideRoot(current.projects_root, projectPath))) {
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
      }),
    "projects.createWorkspaceOnly": (...args) =>
      enqueueProjectMutation(async () => {
        const input = args[0] as Parameters<typeof context.core.projects.createWorkspaceOnly>[0];
        const current = await context.settings.get();
        const existingProjects = await context.projects.refresh(current);
        const requestedId = input.folder_name.trim();
        const requestedIdKey = process.platform === "win32" ? requestedId.toLowerCase() : requestedId;
        if (
          existingProjects.some(
            (entry) => (process.platform === "win32" ? entry.id.toLowerCase() : entry.id) === requestedIdKey,
          )
        ) {
          throw {
            code: "FOLDER_EXISTS",
            message: "项目文件夹名称已被其他项目使用。",
            detail: requestedId,
          } satisfies SiteIndexError;
        }

        const created = await context.core.projects.createWorkspaceOnly(input);
        const projectPath = path.resolve(input.projects_root, created.id);
        const currentAfterCreate = await context.settings.get();
        const projectKey = await pathKey(projectPath);
        const nextExtraProjects = [...currentAfterCreate.extra_projects];
        const extraProjectKeys = await Promise.all(currentAfterCreate.extra_projects.map((entry) => pathKey(entry)));
        if (!(await isProjectInsideRoot(currentAfterCreate.projects_root, projectPath))) {
          if (!extraProjectKeys.includes(projectKey)) nextExtraProjects.push(projectPath);
        }
        const nextHiddenProjects = (
          await Promise.all(
            (currentAfterCreate.hidden_projects ?? []).map(async (entry) => ({ entry, key: await pathKey(entry) })),
          )
        )
          .filter(({ key }) => key !== projectKey)
          .map(({ entry }) => entry);
        const patch: Partial<AppSettings> = {};
        if (nextExtraProjects.length !== currentAfterCreate.extra_projects.length) {
          patch.extra_projects = nextExtraProjects;
        }
        if (nextHiddenProjects.length !== (currentAfterCreate.hidden_projects ?? []).length) {
          patch.hidden_projects = nextHiddenProjects;
        }
        let updated: AppSettings;
        try {
          updated = Object.keys(patch).length > 0 ? await context.settings.set(patch) : currentAfterCreate;
        } catch (error) {
          throw {
            code: "WRITE_FAILED",
            message: "工作区已创建，但项目登记未保存。请在项目中心点击“添加已有项目”，选择刚创建的文件夹来恢复登记。",
            detail: error instanceof Error ? error.message : String(error),
          } satisfies SiteIndexError;
        }
        if (updated !== currentAfterCreate) await context.settingsChanged(updated, false);

        await context.projects.refresh(updated);
        const registeredPath = context.projects.resolveProject(created.id);
        context.core.invalidate(registeredPath);
        context.notifyProjectChanged?.(created.id);
        return { id: created.id };
      }),
    "projects.addExisting": (value) =>
      enqueueProjectMutation(async () => {
        const handlerStartedAt = context.traceAddExisting ? performance.now() : 0;
        const timings: AddExistingTiming[] | null = context.traceAddExisting ? [] : null;
        const recordTiming: AddExistingTimingCallback = (phase, durationMs) => {
          timings?.push({ phase, durationMs });
        };
        const timingCallback = timings ? recordTiming : undefined;
        const measure = async <T>(
          phase: "path_check" | "settings_registration" | "core.projects.get",
          operation: () => Promise<T>,
        ) => {
          if (!timings) return operation();
          const startedAt = performance.now();
          try {
            return await operation();
          } finally {
            recordTiming(phase, performance.now() - startedAt);
          }
        };

        try {
          if (typeof value !== "string") {
            throw { code: "PROJECT_NOT_FOUND", message: "请选择有效的项目目录。" } satisfies SiteIndexError;
          }
          const projectPath = await measure("path_check", () => context.projects.resolveExistingPath(value));
          const { current, updated, registeredAsExtra } = await measure("settings_registration", async () => {
            const current = await context.settings.get();
            let updated: AppSettings = current;
            const registeredAsExtra = !(await isProjectInsideRoot(current.projects_root, projectPath));
            const key = await pathKey(projectPath);
            const hiddenProjects = (
              await Promise.all(
                (current.hidden_projects ?? []).map(async (entry) => ({ entry, key: await pathKey(entry) })),
              )
            )
              .filter((item) => item.key !== key)
              .map((item) => item.entry);
            if (registeredAsExtra) {
              const paths = new Set(current.extra_projects.map((entry) => path.resolve(entry)));
              paths.add(projectPath);
              updated = await context.settings.set({ extra_projects: [...paths], hidden_projects: hiddenProjects });
            } else if (hiddenProjects.length !== (current.hidden_projects ?? []).length) {
              updated = await context.settings.set({ hidden_projects: hiddenProjects });
            }
            return { current, updated, registeredAsExtra };
          });
          if (updated !== current) await context.settingsChanged(updated, false, timingCallback);
          else await context.projects.refresh(current, timingCallback);
          const id = path.basename(projectPath);
          await context.projects.ensureProject(id, updated, timingCallback);
          const project = await measure("core.projects.get", async () => context.core.projects.get(id));
          if (context.reconcileProjectScheduleInBackground) {
            context.reconcileProjectScheduleInBackground(id);
          } else {
            void context.reconcileSchedules(true).catch(() => undefined);
          }
          return project.summary;
        } finally {
          if (timings) {
            recordTiming("handler.total", performance.now() - handlerStartedAt);
            try {
              await context.traceAddExisting?.(timings);
            } catch {
              // 诊断日志不可覆盖添加项目的成功结果或原始错误。
            }
          }
        }
      }),
    "projects.remove": (id) =>
      enqueueProjectMutation(() =>
        context.withProject(id, async (projectId) => {
          const projectPath = context.projects.resolveProject(projectId);
          const current = await context.settings.get();
          const key = await pathKey(projectPath);
          const hiddenProjects = current.hidden_projects ?? [];
          const insideRoot = await isProjectInsideRoot(current.projects_root, projectPath);
          const extraProjects = await Promise.all(
            current.extra_projects.map(async (entry) => ({ entry, key: await pathKey(entry) })),
          );
          const hiddenEntries = await Promise.all(
            hiddenProjects.map(async (entry) => ({ entry, key: await pathKey(entry) })),
          );
          const updated = await context.settings.set({
            extra_projects: extraProjects.filter((item) => item.key !== key).map((item) => item.entry),
            hidden_projects:
              insideRoot && !hiddenEntries.some((item) => item.key === key)
                ? [...hiddenProjects, projectPath]
                : hiddenProjects,
          });
          await context.settingsChanged(updated, false);
          await context.projects.refresh(updated);
          return projectId;
        }),
      ).then(async (projectId) => {
        try {
          const status = await context.reconcileSchedules(true, undefined, undefined, [projectId]);
          if (status.authorization_required) {
            throw {
              code: "UNKNOWN",
              message: "项目已取消登记，但注销系统计划任务需要管理员授权。",
            } satisfies SiteIndexError;
          }
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "UNKNOWN") throw error;
          throw {
            code: "UNKNOWN",
            message: "项目已取消登记，但注销系统计划任务失败。",
            detail: error instanceof Error ? error.message : String(error),
          } satisfies SiteIndexError;
        }
      }),
    "projects.updateConfig": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.projects.updateConfig(id, args[1] as Parameters<typeof context.core.projects.updateConfig>[1]),
      ),
  };
}
