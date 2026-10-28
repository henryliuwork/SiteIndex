import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createSeoHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "seo.summary": (id) => context.withProject(id, (projectId) => context.core.seo.summary(projectId)),
    "seo.listIssues": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.seo.listIssues(id, args[1] as Parameters<typeof context.core.seo.listIssues>[1]),
      ),
    "seo.listPages": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.seo.listPages(id, args[1] as Parameters<typeof context.core.seo.listPages>[1]),
      ),
    "seo.listLinks": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.seo.listLinks(id, args[1] as Parameters<typeof context.core.seo.listLinks>[1]),
      ),
    "seo.orphanPages": (id) => context.withProject(id, (projectId) => context.core.seo.orphanPages(projectId)),
    "seo.getPage": (...args) => context.withProject(args[0], (id) => context.core.seo.getPage(id, args[1] as string)),
    "seo.googleSiteUrl": (url) => context.core.seo.googleSiteUrl(url as string),
    "seo.checkIndex": (id) =>
      context.withProject(id, (projectId) =>
        context.jobs.run({ projectPath: context.projects.resolveProject(projectId), job: "index-check" }),
      ),
  };
}
