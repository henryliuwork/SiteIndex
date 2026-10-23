import { app, clipboard, dialog, ipcMain, shell } from "electron";
import { lstat, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeRunner, type CoreService } from "@siteindex/core";
import { PATHS } from "@siteindex/shared";
import type {
  AppSettings,
  JobRequest,
  ListQuery,
  ProductFilters,
  ProductView,
  ProjectId,
  ProjectUiState,
  SkuStockFilters,
  SkuStockView,
  SiteIndexError,
} from "@siteindex/shared";
import { createHandlerRegistry, serializeIpcError } from "./ipc-registry.js";
import type { JobManager } from "./job-manager.js";
import { isProjectInsideRoot, type ProjectCatalog } from "./project-catalog.js";
import type { SettingsStore } from "./settings-store.js";
import type { UiStateStore } from "./ui-state-store.js";

export async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "选择项目根目录",
    buttonLabel: "使用此目录",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

const INVENTORY_CSV_COLUMNS = [
  "sku",
  "title",
  "variant_title",
  "category",
  "price",
  "stock_status",
  "since",
  "days_in_status",
  "online_rate_7d",
  "online_rate_30d",
  "history_30d",
  "changes_30d",
  "last_change",
  "last_change_at",
] as const satisfies readonly (keyof SkuStockView)[];

const PRODUCT_CSV_COLUMNS = [
  "handle",
  "product_id",
  "title",
  "url",
  "category",
  "categories",
  "price_min",
  "price_max",
  "compare_at_max",
  "currency",
  "on_sale",
  "image_url",
  "image_source",
  "variant_count",
  "skus",
  "in_stock_variants",
  "stock_status",
  "stock_since",
  "tags",
  "priority",
  "exclude_edm",
  "last_featured",
  "days_since_featured",
  "first_seen",
  "status",
] as const satisfies readonly (keyof ProductView)[];

function projectId(value: unknown): ProjectId {
  if (typeof value !== "string" || !value.trim()) {
    throw { code: "PROJECT_NOT_FOUND", message: "项目标识无效。", detail: String(value) } satisfies SiteIndexError;
  }
  return value;
}

function isJobRequest(value: unknown): value is Omit<JobRequest, "trigger"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.projectPath === "string" &&
    request.projectPath.trim().length > 0 &&
    (request.job === "daily" ||
      request.job === "weekly" ||
      request.job === "monthly" ||
      request.job === "validate" ||
      request.job === "readme" ||
      request.job === "design" ||
      request.job === "index-check" ||
      request.job === "views") &&
    (request.only === undefined || typeof request.only === "string") &&
    (request.date === undefined || typeof request.date === "string") &&
    (request.force === undefined || typeof request.force === "boolean") &&
    (request.dryRun === undefined || typeof request.dryRun === "boolean")
  );
}

function invalidJobRequest(message: string): SiteIndexError {
  return { code: "CONFIG_INVALID", message };
}

function desktopError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function childPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function httpUrl(value: unknown): string {
  if (typeof value !== "string") throw desktopError("CONFIG_INVALID", "外部链接无效。");
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // 统一转换为安全策略错误。
  }
  throw desktopError("CONFIG_INVALID", "外部链接只允许 http 或 https。");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value)
    ? value.join(";")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvContent<T extends object>(rows: readonly T[], columns: readonly string[]): string {
  return `\uFEFF${[
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell((row as Record<string, unknown>)[column])).join(",")),
  ].join("\r\n")}`;
}

async function saveCsv(
  title: string,
  defaultName: string,
  rows: readonly object[],
  columns: readonly string[],
): Promise<string> {
  const result = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(app.getPath("downloads"), defaultName),
    filters: [{ name: "CSV 文件", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) {
    throw { code: "UNKNOWN", message: "已取消 CSV 导出。" } satisfies SiteIndexError;
  }
  await writeFile(result.filePath, csvContent(rows, columns), "utf8");
  return result.filePath;
}

export function registerIpcHandlers(
  settings: SettingsStore,
  uiState: UiStateStore,
  core: CoreService,
  projects: ProjectCatalog,
  settingsChanged: (value: AppSettings) => Promise<void>,
  jobs: JobManager,
  onRunnerClaimed?: (id: ProjectId, projectPath: string) => Promise<void>,
): void {
  const withProject = async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>): Promise<T> => {
    const id = projectId(value);
    await projects.ensureProject(id, await settings.get());
    return callback(id);
  };

  const handlers = createHandlerRegistry({
    "app.version": () => app.getVersion(),
    "app.platform": () => (process.platform === "darwin" ? "darwin" : "win32"),
    "settings.get": () => settings.get(),
    "settings.set": async (patch) => {
      const updated = await settings.set(patch as Partial<AppSettings>);
      await settingsChanged(updated);
      return updated;
    },
    "settings.chooseDirectory": (defaultPath) =>
      chooseDirectory(typeof defaultPath === "string" ? defaultPath : undefined),
    "uiState.get": (id) => uiState.get(id as ProjectId),
    "uiState.set": (id, patch) => uiState.set(id as ProjectId, patch as Partial<ProjectUiState>),
    "projects.list": async () => {
      const entries = await projects.refresh(await settings.get());
      const summaries = await Promise.all(entries.map(async ({ id }) => (await core.projects.get(id)).summary));
      return summaries;
    },
    "projects.get": (id) => withProject(id, (projectIdValue) => core.projects.get(projectIdValue)),
    "projects.detect": (...args) => core.projects.detect(args[0] as string),
    "projects.inspectFeed": (...args) =>
      core.projects.inspectFeed(args[0] as string[], args[1] as { sku_field: string; category_depth: number }),
    "projects.create": async (...args) => {
      const result = await core.projects.create(args[0] as Parameters<CoreService["projects"]["create"]>[0]);
      await projects.refresh(await settings.get());
      return result;
    },
    "projects.addExisting": async (value) => {
      if (typeof value !== "string") {
        throw { code: "PROJECT_NOT_FOUND", message: "请选择有效的项目目录。" } satisfies SiteIndexError;
      }
      const projectPath = await projects.resolveExistingPath(value);
      const current = await settings.get();
      let updated = current;
      if (!isProjectInsideRoot(current.projects_root, projectPath)) {
        const paths = new Set(current.extra_projects.map((entry) => path.resolve(entry)));
        paths.add(projectPath);
        updated = await settings.set({ extra_projects: [...paths] });
        await settingsChanged(updated);
      } else {
        await projects.refresh(current);
      }
      const id = path.basename(projectPath);
      await projects.ensureProject(id, updated);
      return (await core.projects.get(id)).summary;
    },
    "projects.updateConfig": (...args) =>
      withProject(args[0], (id) =>
        core.projects.updateConfig(id, args[1] as Parameters<CoreService["projects"]["updateConfig"]>[1]),
      ),
    "overview.get": (id) => withProject(id, (projectIdValue) => core.overview.get(projectIdValue)),
    "inventory.summary": (...args) =>
      withProject(args[0], (id) => core.inventory.summary(id, args[1] as 14 | 30 | undefined)),
    "inventory.listSkus": (...args) =>
      withProject(args[0], (id) => core.inventory.listSkus(id, args[1] as ListQuery<SkuStockFilters>)),
    "inventory.dailyReport": (...args) =>
      withProject(args[0], (id) => core.inventory.dailyReport(id, args[1] as string)),
    "inventory.exportCsv": (...args) =>
      withProject(args[0], async (id) => {
        const query = args[1] as ListQuery<SkuStockFilters>;
        const result = await core.inventory.listSkus(id, { ...query, page: 1, pageSize: 0 });
        return saveCsv("导出库存 CSV", `${id}-inventory.csv`, result.rows, INVENTORY_CSV_COLUMNS);
      }),
    "products.list": (...args) =>
      withProject(args[0], (id) => core.products.list(id, args[1] as ListQuery<ProductFilters>)),
    "products.get": (...args) => withProject(args[0], (id) => core.products.get(id, args[1] as string)),
    "products.setTags": (...args) =>
      withProject(args[0], (id) => core.products.setTags(id, args[1] as string, args[2] as string[])),
    "products.listTags": (id) => withProject(id, (projectIdValue) => core.products.listTags(projectIdValue)),
    "products.createTag": (...args) => withProject(args[0], (id) => core.products.createTag(id, args[1] as string)),
    "products.deleteTag": (...args) => withProject(args[0], (id) => core.products.deleteTag(id, args[1] as string)),
    "products.exportCsv": (...args) =>
      withProject(args[0], async (id) => {
        const query = args[1] as ListQuery<ProductFilters>;
        const result = await core.products.list(id, { ...query, page: 1, pageSize: 0 });
        return saveCsv("导出产品 CSV", `${id}-products.csv`, result.rows, PRODUCT_CSV_COLUMNS);
      }),
    "seo.summary": (id) => withProject(id, (projectIdValue) => core.seo.summary(projectIdValue)),
    "seo.listIssues": (...args) =>
      withProject(args[0], (id) => core.seo.listIssues(id, args[1] as Parameters<CoreService["seo"]["listIssues"]>[1])),
    "seo.listPages": (...args) =>
      withProject(args[0], (id) => core.seo.listPages(id, args[1] as Parameters<CoreService["seo"]["listPages"]>[1])),
    "seo.listLinks": (...args) =>
      withProject(args[0], (id) => core.seo.listLinks(id, args[1] as Parameters<CoreService["seo"]["listLinks"]>[1])),
    "seo.orphanPages": (id) => withProject(id, (projectIdValue) => core.seo.orphanPages(projectIdValue)),
    "seo.getPage": (...args) => withProject(args[0], (id) => core.seo.getPage(id, args[1] as string)),
    "seo.googleSiteUrl": (url) => core.seo.googleSiteUrl(url as string),
    "content.summary": (id) => withProject(id, (projectIdValue) => core.content.summary(projectIdValue)),
    "content.listBlog": (...args) =>
      withProject(args[0], (id) =>
        core.content.listBlog(id, args[1] as Parameters<CoreService["content"]["listBlog"]>[1]),
      ),
    "content.listKeywords": (...args) =>
      withProject(args[0], (id) =>
        core.content.listKeywords(id, args[1] as Parameters<CoreService["content"]["listKeywords"]>[1]),
      ),
    "content.listDrafts": (id) => withProject(id, (projectIdValue) => core.content.listDrafts(projectIdValue)),
    "edm.summary": (id) => withProject(id, (projectIdValue) => core.edm.summary(projectIdValue)),
    "edm.listImages": (...args) =>
      withProject(args[0], (id) => core.edm.listImages(id, args[1] as Parameters<CoreService["edm"]["listImages"]>[1])),
    "edm.setManualImage": (...args) =>
      withProject(args[0], (id) => core.edm.setManualImage(id, args[1] as string, args[2] as string | null)),
    "edm.buildCommand": (...args) =>
      withProject(args[0], (id) =>
        core.edm.buildCommand(id, args[1] as Parameters<CoreService["edm"]["buildCommand"]>[1]),
      ),
    "readme.get": (id) => withProject(id, (projectIdValue) => core.readme.get(projectIdValue)),
    "readme.saveUserBlocks": (...args) =>
      withProject(args[0], (id) =>
        core.readme.saveUserBlocks(id, args[1] as Parameters<CoreService["readme"]["saveUserBlocks"]>[1]),
      ),
    "readme.refresh": (id) => withProject(id, (projectIdValue) => core.readme.refresh(projectIdValue)),
    "files.lastReport": (id) => withProject(id, (projectIdValue) => core.files.lastReport(projectIdValue)),
    "files.validate": (...args) => withProject(args[0], (id) => core.files.validate(id, args[1] as string | undefined)),
    "files.repair": (...args) =>
      withProject(args[0], (id) =>
        core.files.repair(id, args[1] as string, args[2] as Parameters<CoreService["files"]["repair"]>[2]),
      ),
    "jobs.run": (request) => {
      if (!isJobRequest(request)) throw invalidJobRequest("Job 请求无效。");
      return jobs.run(request);
    },
    "jobs.cancel": (runId) => {
      if (typeof runId !== "string" || !runId.trim()) throw invalidJobRequest("Job 标识无效。");
      return jobs.cancel(runId);
    },
    "jobs.history": (id, limit) => {
      if (typeof id !== "string" || !id.trim() || (limit !== undefined && typeof limit !== "number")) {
        throw invalidJobRequest("Job 历史查询参数无效。");
      }
      return jobs.history(id as ProjectId, limit as number | undefined);
    },
    "jobs.running": (id) => {
      if (typeof id !== "string" || !id.trim()) throw invalidJobRequest("项目标识无效。");
      return jobs.running(id as ProjectId);
    },
    "folders.list": (id) => withProject(id, (projectIdValue) => core.folders.list(projectIdValue)),
    "folders.create": (...args) =>
      withProject(args[0], (id) => core.folders.create(id, args[1] as string, args[2] as string)),
    "folders.describe": (...args) =>
      withProject(args[0], (id) => core.folders.describe(id, args[1] as string, args[2] as string)),
    "folders.remove": (...args) =>
      withProject(args[0], async (id) => {
        if (typeof args[1] !== "string" || !args[1].trim()) {
          throw desktopError("PROJECT_NOT_FOUND", "请选择要删除的工作区文件夹。");
        }
        const requestedName = args[1].trim();
        const entries = await core.folders.list(id);
        const folder = entries.find((entry) => entry.name === requestedName);
        if (!folder) throw desktopError("PROJECT_NOT_FOUND", "找不到工作区文件夹。", requestedName);
        if (folder.default) throw desktopError("CONFIG_INVALID", "默认工作区文件夹不能删除。", folder.name);

        const projectPath = await realpath(projects.resolveProject(id));
        const targetPath = path.resolve(projectPath, folder.name);
        if (!childPath(projectPath, targetPath) || path.relative(projectPath, targetPath).includes(path.sep)) {
          throw desktopError("PATH_OUTSIDE_PROJECT", "只能删除项目根目录下的自定义文件夹。", folder.name);
        }
        const targetInfo = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!targetInfo?.isDirectory() || targetInfo.isSymbolicLink()) {
          throw desktopError("PATH_OUTSIDE_PROJECT", "目标不是项目内的普通文件夹，已拒绝删除。", folder.name);
        }
        const resolvedTarget = await realpath(targetPath);
        if (!childPath(projectPath, resolvedTarget) || path.relative(projectPath, resolvedTarget).includes(path.sep)) {
          throw desktopError("PATH_OUTSIDE_PROJECT", "文件夹解析后不在项目目录内，已拒绝删除。", folder.name);
        }

        const project = await core.projects.get(id);
        const previousFolders = project.config.workspace_folders;
        const nextFolders = previousFolders.filter((entry) => entry.name !== folder.name);
        await core.projects.updateConfig(id, { workspace_folders: nextFolders });
        try {
          await shell.trashItem(resolvedTarget);
        } catch (error) {
          await core.projects.updateConfig(id, { workspace_folders: previousFolders }).catch((rollbackError) => {
            console.error("恢复工作区配置失败。", id, folder.name, rollbackError);
          });
          throw desktopError("WRITE_FAILED", "无法将工作区文件夹移入回收站。", String(error));
        }

        core.invalidate(projectPath);
        await core.readme.refresh(id).catch((error) => {
          console.warn("工作区文件夹已删除，但 README 刷新失败。", id, error);
        });
        return core.folders.list(id);
      }),
    "folders.open": (...args) =>
      withProject(args[0], async (id) => {
        const requestedName = args[1];
        const projectPath = await realpath(projects.resolveProject(id));
        let targetPath = projectPath;
        if (requestedName !== undefined) {
          if (typeof requestedName !== "string" || !requestedName.trim()) {
            throw desktopError("PROJECT_NOT_FOUND", "请选择有效的工作区文件夹。");
          }
          const folder = (await core.folders.list(id)).find((entry) => entry.name === requestedName.trim());
          if (!folder) throw desktopError("PROJECT_NOT_FOUND", "找不到工作区文件夹。", requestedName);
          targetPath = path.resolve(projectPath, folder.name);
          if (!childPath(projectPath, targetPath) || path.relative(projectPath, targetPath).includes(path.sep)) {
            throw desktopError("PATH_OUTSIDE_PROJECT", "只能打开项目根目录下的工作区文件夹。", folder.name);
          }
          const targetInfo = await lstat(targetPath);
          if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
            throw desktopError("PATH_OUTSIDE_PROJECT", "目标不是项目内的普通文件夹。", folder.name);
          }
          const resolvedTarget = await realpath(targetPath);
          if (!childPath(projectPath, resolvedTarget) || path.relative(projectPath, resolvedTarget).includes(path.sep)) {
            throw desktopError("PATH_OUTSIDE_PROJECT", "文件夹解析后不在项目目录内。", folder.name);
          }
          targetPath = resolvedTarget;
        }
        const error = await shell.openPath(targetPath);
        if (error) throw desktopError("UNKNOWN", "无法打开文件夹。", error);
      }),
    "runner.get": (id) => withProject(id, (projectIdValue) => core.runner.get(projectIdValue)),
    "runner.claim": (id) =>
      withProject(id, async (projectIdValue) => {
        const projectPath = projects.resolveProject(projectIdValue);
        const current = await settings.get();
        const previous = await core.runner.get(projectIdValue);
        const nextRunner = {
          device_id: current.device_id,
          device_name: current.device_name,
          claimed_at: new Date().toISOString(),
        };
        await writeRunner(projectPath, nextRunner);
        core.invalidate(projectPath);
        try {
          await onRunnerClaimed?.(projectIdValue, projectPath);
        } catch (error) {
          if (previous.runner) await writeRunner(projectPath, previous.runner).catch(() => undefined);
          else await unlink(path.join(projectPath, PATHS.runner)).catch(() => undefined);
          core.invalidate(projectPath);
          throw desktopError("WRITE_FAILED", "本机计划任务注册失败，已恢复原执行设备。", String(error));
        }
        await dialog.showMessageBox({
          type: "info",
          title: "执行设备已更新",
          message: "本机已认领为此项目的执行设备。",
          detail:
            previous.runner && previous.runner.device_id !== current.device_id
              ? `原执行设备“${previous.runner.device_name}”上的计划任务在同步到新认领状态后会自动跳过。`
              : "项目计划任务将在本机同步并执行。",
        });
        return core.runner.get(projectIdValue);
      }),
    "shell.openPath": async (value) => {
      if (typeof value !== "string" || !value.trim()) throw desktopError("CONFIG_INVALID", "打开路径无效。");
      const error = await shell.openPath(value);
      if (error) throw desktopError("UNKNOWN", "无法打开路径。", error);
    },
    "shell.openExternal": async (value) => {
      await shell.openExternal(httpUrl(value));
    },
    "shell.copyText": async (value) => {
      if (typeof value !== "string") throw desktopError("CONFIG_INVALID", "复制内容必须是文本。");
      clipboard.writeText(value);
    },
  });

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    });
  }
}
