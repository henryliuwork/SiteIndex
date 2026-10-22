import { app, dialog, ipcMain } from "electron";
import type { AppSettings } from "@siteindex/shared";
import { createHandlerRegistry, serializeIpcError } from "./ipc-registry.js";
import type { SettingsStore } from "./settings-store.js";

export async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "选择项目根目录",
    buttonLabel: "使用此目录",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function registerIpcHandlers(settings: SettingsStore): void {
  const handlers = createHandlerRegistry({
    "app.version": () => app.getVersion(),
    "app.platform": () => (process.platform === "darwin" ? "darwin" : "win32"),
    "settings.get": () => settings.get(),
    "settings.set": (patch) => settings.set(patch as Partial<AppSettings>),
    "settings.chooseDirectory": (defaultPath) =>
      chooseDirectory(typeof defaultPath === "string" ? defaultPath : undefined),
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
