import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createContentHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "content.summary": (id) => context.withProject(id, (projectId) => context.core.content.summary(projectId)),
    "content.listBlog": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.content.listBlog(id, args[1] as Parameters<typeof context.core.content.listBlog>[1]),
      ),
    "content.listKeywords": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.content.listKeywords(id, args[1] as Parameters<typeof context.core.content.listKeywords>[1]),
      ),
    "content.listDrafts": (id) => context.withProject(id, (projectId) => context.core.content.listDrafts(projectId)),
  };
}
