import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createReadmeHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "readme.get": (id) => context.withProject(id, (projectId) => context.core.readme.get(projectId)),
    "readme.saveUserBlocks": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.readme.saveUserBlocks(id, args[1] as Parameters<typeof context.core.readme.saveUserBlocks>[1]),
      ),
    "readme.refresh": (id) => context.withProject(id, (projectId) => context.core.readme.refresh(projectId)),
  };
}
