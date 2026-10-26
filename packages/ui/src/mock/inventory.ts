import type { ListQuery, SkuStockFilters, SiteIndexApi } from "@siteindex/shared";
import { fixtures, inventorySummary, projectKey, projectSummaries, reply, rowsByProject, selectRows, todaySkus } from "./context";

export function createInventoryMock(): SiteIndexApi["inventory"] {
  return {
    summary: (id, days = 30) => reply(() => inventorySummary(id, days)),
    listSkus: (id, query: ListQuery<SkuStockFilters>) => reply(() => selectRows(
      rowsByProject[projectKey(id)], query,
      (row) => [row.sku, row.title, row.variant_title, row.category].join(" "),
      (row, filters) => {
        const status = filters.status as SkuStockFilters["status"];
        const category = filters.category as string | undefined;
        return (!status || (status === "today" ? todaySkus[projectKey(id)].has(row.sku) : row.stock_status === status)) && (!category || row.category === category);
      },
    )),
    dailyReport: (id, date) => reply(() => fixtures.dailyReports.find((report) => report.date === date)?.markdown ?? "# " + projectSummaries[projectKey(id)].domain + " 库存日报 · " + date + "\n\n暂无该日期的日报。"),
    exportCsv: (id) => reply("mock:/exports/" + id + "-inventory.csv"),
  };
}
