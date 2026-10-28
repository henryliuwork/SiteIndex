import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createDesignHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "design.get": (id) => context.withProject(id, (projectId) => context.core.design.get(projectId)),
  };
}
