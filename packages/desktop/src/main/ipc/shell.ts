import { clipboard, shell } from "electron";
import type { SiteIndexError } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";

function desktopError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
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

export function createShellHandlers(): IpcHandlerImplementations {
  return {
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
  };
}
