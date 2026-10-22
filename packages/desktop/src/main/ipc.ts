import { app, ipcMain } from "electron";
import { createHandlerRegistry, serializeIpcError } from "./ipc-registry.js";

export function registerIpcHandlers(): void {
  const handlers = createHandlerRegistry({
    "app.version": () => app.getVersion(),
    "app.platform": () => (process.platform === "darwin" ? "darwin" : "win32"),
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
