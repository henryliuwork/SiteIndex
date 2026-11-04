import type { HistoryRange, InventorySummary, ListQuery, ProjectId, SkuStockFilters, SiteIndexApi, SkuStockView } from "@siteindex/shared";
import { FIXED_TODAY, fixtures, inventorySummary, projectConfigs, projectKey, projectSummaries, reply, rowsByProject, selectRows, todaySkus } from "./context";

type MockSkuRow = SkuStockView;
type MockHistoryRange = 14 | HistoryRange;
type MockInventoryApi = Omit<SiteIndexApi["inventory"], "summary"> & {
  summary(id: ProjectId, range?: MockHistoryRange): Promise<InventorySummary>;
};

function parentRows(rows: readonly SkuStockView[]): MockSkuRow[] {
  const groups = new Map<string, SkuStockView[]>();
  const existingSkus = new Set(rows.map((row) => row.sku));
  for (const row of rows) {
    if (!row.parent_sku || existingSkus.has(row.parent_sku)) continue;
    const children = groups.get(row.parent_sku) ?? [];
    children.push(row);
    groups.set(row.parent_sku, children);
  }
  const parents = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([parentSku, children]) => {
    children.sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
    const representative = children[0]!;
    const categoryCounts = new Map<string, number>();
    for (const child of children) categoryCounts.set(child.category, (categoryCounts.get(child.category) ?? 0) + 1);
    const category = [...categoryCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? "";
    const stockStatus: SkuStockView["stock_status"] = children.some((child) => child.stock_status === "in_stock") ? "in_stock"
      : children.every((child) => child.stock_status === "out_of_stock") ? "out_of_stock"
        : children.some((child) => child.stock_status === "preorder") ? "preorder" : "unknown";
    return {
      ...representative,
      sku: parentSku,
      variant_title: null,
      category,
      price: Math.min(...children.map((child) => child.price)),
      stock_status: stockStatus,
      since: FIXED_TODAY,
      days_in_status: 0,
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
  const groupedChildren = new Set([...groups.values()].flatMap((children) => children.map((child) => child.sku)));
  return [...parents, ...rows.filter((row) => !groupedChildren.has(row.sku))];
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
      const parentView = Boolean(filters.parent_only && projectConfigs[key].sku_grouping?.enabled);
      const source: MockSkuRow[] = parentView ? parentRows(rowsByProject[key]) : rowsByProject[key];
      const childrenByParent = new Map<string, SkuStockView[]>();
      if (parentView) for (const row of rowsByProject[key]) {
        if (!row.parent_sku) continue;
        const children = childrenByParent.get(row.parent_sku) ?? [];
        children.push(row);
        childrenByParent.set(row.parent_sku, children);
      }
      const relatedRows = (row: SkuStockView) => row.is_parent ? childrenByParent.get(row.sku) ?? [] : [row];
      return selectRows(
      source, query,
      (row) => [row.sku, row.title, row.variant_title, row.category,
        ...(row.is_parent ? relatedRows(row).map((child) => child.sku) : [])].join(" "),
      (row, filters) => {
        const status = filters.status as SkuStockFilters["status"];
        const category = filters.category as string | undefined;
        const priceRange = filters.price_changed_within as HistoryRange | undefined;
        return (!status || (status === "today" ? relatedRows(row).some((child) => todaySkus[key].has(child.sku)) : row.stock_status === status))
          && (!category || row.category === category)
          && (!filters.watched_only || watchedCategoryKeys.has(row.category))
          && (!priceRange || relatedRows(row).some((child) => priceChangedWithin(child, priceRange)));
      },
      );
    }),
    dailyReport: (id, date) => reply(() => fixtures.dailyReports.find((report) => report.date === date)?.markdown ?? "# " + projectSummaries[projectKey(id)].domain + " 库存日报 · " + date + "\n\n暂无该日期的日报。"),
    exportCsv: (id) => reply("mock:/exports/" + id + "-inventory.csv"),
  };
}
