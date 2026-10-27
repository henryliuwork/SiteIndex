import { realpath } from "node:fs/promises";
import { shell } from "electron";
import type { SiteIndexError } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

function openError(detail: string): SiteIndexError {
  return { code: "UNKNOWN", message: "无法打开项目文件夹。", detail };
}

export function createFoldersHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    // 兼容仍透传旧契约的界面；工作目录不再由 SiteIndex 管理。
    "folders.list": () => [],
    "folders.create": () => [],
    "folders.describe": () => [],
    "folders.remove": () => [],
    // 旧 name 参数保留在契约中，但只打开项目根目录。
    "folders.open": (id) =>
      context.withProject(id, async (projectId) => {
        const projectPath = await realpath(context.projects.resolveProject(projectId));
        const error = await shell.openPath(projectPath);
        if (error) throw openError(error);
      }),
  };
}
