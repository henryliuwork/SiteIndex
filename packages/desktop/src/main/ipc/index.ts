import { ipcMain } from "electron";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import { createIpcContext, type IpcDependencies } from "./context.js";
import { createIpcHandlerImplementations } from "./handlers.js";

export function registerIpcHandlers(dependencies: IpcDependencies): void {
  const context = createIpcContext(dependencies);
  const handlers = createHandlerRegistry(createIpcHandlerImplementations(context));

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
