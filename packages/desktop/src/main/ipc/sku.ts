import type { SkuGroupingRule } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createSkuHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "sku.previewGrouping": (...args) =>
      context.withProject(args[0], (id) => context.core.sku.previewGrouping(id, args[1] as SkuGroupingRule)),
  };
}
