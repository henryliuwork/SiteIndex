import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createCategoriesHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "categories.get": (id) => context.withProject(id, (projectId) => context.core.categories.get(projectId)),
    "categories.preview": (...args) =>
      context.withProject(args[0], (projectId) =>
        context.core.categories.preview(projectId, args[1] as Parameters<typeof context.core.categories.preview>[1]),
      ),
    "categories.save": (...args) =>
      context.withProject(args[0], (projectId) =>
        context.core.categories.save(projectId, args[1] as Parameters<typeof context.core.categories.save>[1]),
      ),
  };
}
