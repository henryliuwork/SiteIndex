import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createTodosHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "todos.list": (id) => context.withProject(id, (projectId) => context.core.todos.list(projectId)),
    "todos.update": (...args) =>
      context.withProject(args[0], (projectId) =>
        context.core.todos.update(projectId, args[1] as Parameters<IpcContext["core"]["todos"]["update"]>[1]),
      ),
    "todos.history": (...args) =>
      context.withProject(args[0], (projectId) => context.core.todos.history(projectId, args[1] as string)),
  };
}
