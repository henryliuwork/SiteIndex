import { app, dialog } from "electron";
import type { IpcHandlerImplementations } from "../ipc-registry.js";

export async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "选择项目根目录",
    buttonLabel: "使用此目录",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function createAppHandlers(): IpcHandlerImplementations {
  return {
    "app.version": () => app.getVersion(),
    "app.platform": () => (process.platform === "darwin" ? "darwin" : "win32"),
  };
}
