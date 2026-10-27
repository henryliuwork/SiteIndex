import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createUpdatesHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "updates.check": () => context.updates.check(),
    "updates.download": () => context.updates.download(),
    "updates.install": () => context.updates.install(),
  };
}
