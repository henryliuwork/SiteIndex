import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

function todoServiceNotReady(): { code: "NOT_IMPLEMENTED"; message: string; detail: string } {
  return {
    code: "NOT_IMPLEMENTED",
    message: "待办 Core 服务尚未接入。",
    detail: "Desktop IPC 与 preload 已就绪，等待 Core 暴露 todos 服务。",
  };
}

export function createTodosHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "todos.list": (id) =>
      context.withProject(id, (projectId) => {
        if (!context.todos) throw todoServiceNotReady();
        return context.todos.list(projectId);
      }),
    "todos.update": (...args) =>
      context.withProject(args[0], (projectId) => {
        if (!context.todos) throw todoServiceNotReady();
        return context.todos.update(projectId, args[1] as Parameters<NonNullable<IpcContext["todos"]>["update"]>[1]);
      }),
    "todos.history": (...args) =>
      context.withProject(args[0], (projectId) => {
        if (!context.todos) throw todoServiceNotReady();
        return context.todos.history(projectId, args[1] as string);
      }),
  };
}
