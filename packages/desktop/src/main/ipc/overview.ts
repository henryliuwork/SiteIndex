import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createOverviewHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "overview.get": (id) => context.withProject(id, (projectId) => context.core.overview.get(projectId)),
  };
}
