import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import type { SiteIndexError } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

function desktopError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function childPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createFoldersHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "folders.list": (id) => context.withProject(id, (projectId) => context.core.folders.list(projectId)),
    "folders.create": (...args) =>
      context.withProject(args[0], (id) => context.core.folders.create(id, args[1] as string, args[2] as string)),
    "folders.describe": (...args) =>
      context.withProject(args[0], (id) => context.core.folders.describe(id, args[1] as string, args[2] as string)),
    "folders.remove": (...args) =>
      context.withProject(args[0], async (id) => {
        if (typeof args[1] !== "string" || !args[1].trim()) {
          throw desktopError("PROJECT_NOT_FOUND", "请选择要删除的工作区文件夹。");
        }
        const requestedName = args[1].trim();
        const entries = await context.core.folders.list(id);
        const folder = entries.find((entry) => entry.name === requestedName);
        if (!folder) throw desktopError("PROJECT_NOT_FOUND", "找不到工作区文件夹。", requestedName);
        if (folder.default) throw desktopError("CONFIG_INVALID", "默认工作区文件夹不能删除。", folder.name);

        const projectPath = await realpath(context.projects.resolveProject(id));
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

        const project = await context.core.projects.get(id);
        const previousFolders = project.config.workspace_folders;
        const nextFolders = previousFolders.filter((entry) => entry.name !== folder.name);
        await context.core.projects.updateConfig(id, { workspace_folders: nextFolders });
        try {
          await shell.trashItem(resolvedTarget);
        } catch (error) {
          await context.core.projects.updateConfig(id, { workspace_folders: previousFolders }).catch((rollbackError) => {
            console.error("恢复工作区配置失败。", id, folder.name, rollbackError);
          });
          throw desktopError("WRITE_FAILED", "无法将工作区文件夹移入回收站。", String(error));
        }

        context.core.invalidate(projectPath);
        await context.core.readme.refresh(id).catch((error) => {
          console.warn("工作区文件夹已删除，但 README 刷新失败。", id, error);
        });
        return context.core.folders.list(id);
      }),
    "folders.open": (...args) =>
      context.withProject(args[0], async (id) => {
        const requestedName = args[1];
        const projectPath = await realpath(context.projects.resolveProject(id));
        let targetPath = projectPath;
        if (requestedName !== undefined) {
          if (typeof requestedName !== "string" || !requestedName.trim()) {
            throw desktopError("PROJECT_NOT_FOUND", "请选择有效的工作区文件夹。");
          }
          const folder = (await context.core.folders.list(id)).find((entry) => entry.name === requestedName.trim());
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
  };
}
