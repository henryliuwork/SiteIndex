import type { HistoryRange, InventorySummary, ListQuery, ProjectId, SkuStockFilters, SiteIndexApi, SkuStockView } from "@siteindex/shared";
import { FIXED_TODAY, fixtures, inventorySummary, projectConfigs, projectKey, projectSummaries, reply, rowsByProject, selectRows, todaySkus } from "./context";

type MockSkuRow = SkuStockView;
type MockHistoryRange = 14 | HistoryRange;
type MockInventoryApi = Omit<SiteIndexApi["inventory"], "summary"> & {
  summary(id: ProjectId, range?: MockHistoryRange): Promise<InventorySummary>;
};

function parentHistory(children: readonly SkuStockView[]): string {
  return Array.from({ length: 30 }, (_, day) => {
    // 与 Core 一致："-" 表示尚未上架；短历史越界得到的 undefined 视为未知状态。
    const states = children.map((child) => child.history_30d[day]).filter((state) => state !== "-");
    if (states.length === 0) return "-";
    if (states.includes("i")) return "i";
    if (states.every((state) => state === "o")) return "o";
    if (states.includes("p")) return "p";
    return "u";
  }).join("");
}

function onlineRate(history: string, days: 7 | 30): number | null {
  const available = [...history.slice(-days)].filter((state) => state !== "-");
  if (available.length === 0) return null;
  return available.filter((state) => state === "i").length / available.length;
}

function dateAtOffset(date: string, offset: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function recentStockChanges(history: string, asOf: string): { count: number; lastChangedAt: string | null } {
  let count = 0;
  let lastChangedAt: string | null = null;
  for (let day = 1; day < history.length; day += 1) {
    const previous = history[day - 1];
    const current = history[day];
    if (previous === "-" || current === "-" || previous === current) continue;
    count += 1;
    lastChangedAt = dateAtOffset(asOf, day - 29);
  }
  return { count, lastChangedAt };
}

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
    const history = parentHistory(children);
    const changes = recentStockChanges(history, FIXED_TODAY);
    return {
      ...representative,
      sku: parentSku,
      variant_title: null,
      category,
      price: Math.min(...children.map((child) => child.price)),
      stock_status: stockStatus,
      since: FIXED_TODAY,
      days_in_status: 0,
      online_rate_7d: onlineRate(history, 7),
      online_rate_30d: onlineRate(history, 30),
      history_30d: history,
      changes_30d: changes.count,
      last_change: changes.lastChangedAt ? "stock_change" : null,
      last_change_at: changes.lastChangedAt,
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
      "sku", (row) => row.sku,
      );
    }),
    dailyReport: (id, date) => reply(() => fixtures.dailyReports.find((report) => report.date === date)?.markdown ?? "# " + projectSummaries[projectKey(id)].domain + " 库存日报 · " + date + "\n\n暂无该日期的日报。"),
    exportCsv: (id) => reply("mock:/exports/" + id + "-inventory.csv"),
  };
}
