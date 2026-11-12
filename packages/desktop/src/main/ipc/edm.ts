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
      context.withProject(args[0], (id) =>
        context.core.edm.setManualImage(id, args[1] as string, args[2] as string | null),
      ),
    "edm.setDiscountTier": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.edm.setDiscountTier(id, args[1] as string, args[2] as number | null),
      ),
    "edm.buildCommand": (...args) =>
      context.withProject(args[0], (id) =>
        context.core.edm.buildCommand(id, args[1] as Parameters<typeof context.core.edm.buildCommand>[1]),
      ),
    "edm.exportIndex": async (id) => {
      const renderIndex = context.core.edm.renderIndex;
      const saveEdmSkuIndex = context.saveEdmSkuIndex;
      if (!renderIndex || !saveEdmSkuIndex) {
        throw {
          code: "NOT_IMPLEMENTED",
          message: "当前版本尚未接入 EDM SKU 清单生成。",
          detail: "Core 清单渲染或 Desktop 原生另存尚未就绪。",
        };
      }
      return context.withProject(id, async (projectId) => {
        const rendered = await renderIndex.call(context.core.edm, projectId);
        return saveEdmSkuIndex(context.projects.resolveProject(projectId), rendered);
      });
    },
  };
}
