import type { ListQuery, ProductFilters } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { PRODUCT_CSV_COLUMNS, saveCsv } from "./csv.js";
import type { IpcContext } from "./context.js";

export function createProductsHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "products.list": (...args) =>
      context.withProject(args[0], (id) => context.core.products.list(id, args[1] as ListQuery<ProductFilters>)),
    "products.get": (...args) => context.withProject(args[0], (id) => context.core.products.get(id, args[1] as string)),
    "products.setTags": (...args) =>
      context.withProject(args[0], (id) => context.core.products.setTags(id, args[1] as string, args[2] as string[])),
    "products.listTags": (id) => context.withProject(id, (projectId) => context.core.products.listTags(projectId)),
    "products.createTag": (...args) =>
      context.withProject(args[0], (id) => context.core.products.createTag(id, args[1] as string)),
    "products.deleteTag": (...args) =>
      context.withProject(args[0], (id) => context.core.products.deleteTag(id, args[1] as string)),
    "products.exportCsv": (...args) =>
      context.withProject(args[0], async (id) => {
        const query = args[1] as ListQuery<ProductFilters>;
        const result = await context.core.products.list(id, { ...query, page: 1, pageSize: 0 });
        return saveCsv("导出产品 CSV", `${id}-products.csv`, result.rows, PRODUCT_CSV_COLUMNS);
      }),
  };
}
