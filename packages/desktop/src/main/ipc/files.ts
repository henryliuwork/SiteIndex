import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createFilesHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "files.lastReport": (id) => context.withProject(id, (projectId) => context.core.files.lastReport(projectId)),
    "files.validate": (...args) =>
      context.withProject(args[0], (id) => context.core.files.validate(id, args[1] as string | undefined)),
    "files.repair": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.files.repair(id, args[1] as string, args[2] as Parameters<typeof context.core.files.repair>[2]),
      ),
  };
}
