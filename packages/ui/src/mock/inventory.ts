import type { HistoryRange, InventorySummary, ListQuery, ProjectId, SkuStockFilters, SiteIndexApi, SkuStockView } from "@siteindex/shared";
import { FIXED_TODAY, fixtures, inventorySummary, projectConfigs, projectKey, projectSummaries, reply, rowsByProject, selectRows, todaySkus } from "./context";

type MockSkuRow = SkuStockView & { is_parent?: boolean; children_count?: number; in_stock_children_count?: number };
type MockHistoryRange = 14 | HistoryRange;
type MockInventoryApi = Omit<SiteIndexApi["inventory"], "summary"> & {
  summary(id: ProjectId, range?: MockHistoryRange): Promise<InventorySummary>;
};

function parentRows(rows: readonly SkuStockView[]): MockSkuRow[] {
  const groups = new Map<string, SkuStockView[]>();
  for (const row of rows) {
    if (!row.parent_sku) continue;
    const children = groups.get(row.parent_sku) ?? [];
    children.push(row);
    groups.set(row.parent_sku, children);
  }
  return [...groups].map(([parentSku, children]) => {
    const representative = children[0]!;
    return {
      ...representative,
      sku: parentSku,
      variant_title: null,
      stock_status: children.some((child) => child.stock_status === "in_stock") ? "in_stock" : representative.stock_status,
      online_rate_7d: null,
      online_rate_30d: null,
      history_30d: "u".repeat(30),
      changes_30d: 0,
      last_change: null,
      last_change_at: null,
      parent_sku: null,
      price_history: [],
      is_parent: true,
      children_count: children.length,
      in_stock_children_count: children.filter((child) => child.stock_status === "in_stock").length,
    };
  });
}

function priceChangedWithin(row: SkuStockView, range: HistoryRange): boolean {
  const cutoff = range === "all" ? Number.NEGATIVE_INFINITY : Date.parse(FIXED_TODAY) - range * 86_400_000;
  return fixtures.events.some((event) => event.sku === row.sku
    && event.type === "price_change"
    && Date.parse(event.date) >= cutoff);
}

export function createInventoryMock(): MockInventoryApi {
  return {
    summary: (id, range = 30) => reply(() => inventorySummary(id, range)),
    listSkus: (id, query: ListQuery<SkuStockFilters>) => reply(() => {
      const key = projectKey(id);
      const filters = query.filters ?? {};
      const watchedCategories = projectConfigs[key].categories.watched ?? [];
      const watchedCategoryKeys = new Set(watchedCategories.flatMap((item) => [item.slug, item.name]).map((value) => value?.trim()).filter((value): value is string => Boolean(value)));
      const source: MockSkuRow[] = filters.parent_only ? parentRows(rowsByProject[key]) : rowsByProject[key];
      return selectRows(
      source, query,
      (row) => [row.sku, row.title, row.variant_title, row.category].join(" "),
      (row, filters) => {
        const status = filters.status as SkuStockFilters["status"];
        const category = filters.category as string | undefined;
        const priceRange = filters.price_changed_within as HistoryRange | undefined;
        return (!status || (status === "today" ? todaySkus[key].has(row.sku) : row.stock_status === status))
          && (!category || row.category === category)
          && (!filters.watched_only || watchedCategoryKeys.has(row.category))
          && (!priceRange || priceChangedWithin(row, priceRange));
      },
      );
    }),
    dailyReport: (id, date) => reply(() => fixtures.dailyReports.find((report) => report.date === date)?.markdown ?? "# " + projectSummaries[projectKey(id)].domain + " 库存日报 · " + date + "\n\n暂无该日期的日报。"),
    exportCsv: (id) => reply("mock:/exports/" + id + "-inventory.csv"),
  };
}
