import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createEdmHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "edm.summary": (id) => context.withProject(id, (projectId) => context.core.edm.summary(projectId)),
    "edm.listImages": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.edm.listImages(id, args[1] as Parameters<typeof context.core.edm.listImages>[1]),
      ),
    "edm.setManualImage": (...args) =>
      context.withProject(args[0], (id) => context.core.edm.setManualImage(id, args[1] as string, args[2] as string | null)),
    "edm.buildCommand": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.edm.buildCommand(id, args[1] as Parameters<typeof context.core.edm.buildCommand>[1]),
      ),
  };
}
