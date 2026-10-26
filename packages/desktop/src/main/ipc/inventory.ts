import type { ListQuery, SkuStockFilters } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { INVENTORY_CSV_COLUMNS, saveCsv } from "./csv.js";
import type { IpcContext } from "./context.js";

export function createInventoryHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "inventory.summary": (...args) =>
      context.withProject(args[0], (id) => context.core.inventory.summary(id, args[1] as 14 | 30 | undefined)),
    "inventory.listSkus": (...args) =>
      context.withProject(args[0], (id) => context.core.inventory.listSkus(id, args[1] as ListQuery<SkuStockFilters>)),
    "inventory.dailyReport": (...args) =>
      context.withProject(args[0], (id) => context.core.inventory.dailyReport(id, args[1] as string)),
    "inventory.exportCsv": (...args) =>
      context.withProject(args[0], async (id) => {
        const query = args[1] as ListQuery<SkuStockFilters>;
        const result = await context.core.inventory.listSkus(id, { ...query, page: 1, pageSize: 0 });
        return saveCsv("导出库存 CSV", `${id}-inventory.csv`, result.rows, INVENTORY_CSV_COLUMNS);
      }),
  };
}
