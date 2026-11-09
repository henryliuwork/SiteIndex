import type { DayState, ISODate, SkuStockView, StockStatus } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

export interface ParentStockRows {
  rows: SkuStockView[];
  childrenByParent: Map<string, SkuStockView[]>;
}

function statusFromChildren(statuses: readonly StockStatus[]): StockStatus {
  if (statuses.includes("in_stock")) return "in_stock";
  if (statuses.length > 0 && statuses.every((status) => status === "out_of_stock")) return "out_of_stock";
  if (statuses.includes("preorder")) return "preorder";
  return "unknown";
}

function parentStatus(children: readonly SkuStockView[]): StockStatus {
  return statusFromChildren(children.map((child) => child.stock_status));
}

function stateFromSymbol(symbol: string | undefined): StockStatus | null {
  if (symbol === "-") return null;
  if (symbol === "i") return "in_stock";
  if (symbol === "o") return "out_of_stock";
  if (symbol === "p") return "preorder";
  return "unknown";
}

function symbolFromStatus(status: StockStatus): Exclude<DayState, "-"> {
  if (status === "in_stock") return "i";
  if (status === "out_of_stock") return "o";
  if (status === "preorder") return "p";
  return "u";
}

function parentHistory(children: readonly SkuStockView[]): string {
  const states: string[] = [];
  for (let day = 0; day < 30; day += 1) {
    const available = children
      .map((child) => stateFromSymbol(child.history_30d[day]))
      .filter((status): status is StockStatus => status !== null);
    states.push(available.length ? symbolFromStatus(statusFromChildren(available)) : "-");
  }
  return states.join("");
}

function onlineRate(history: string, days: 7 | 30): number | null {
  const available = [...history.slice(-days)].filter((state) => state !== "-");
  if (!available.length) return null;
  return available.filter((state) => state === "i").length / available.length;
}

function dateAtOffset(date: ISODate, offset: number): ISODate {
  const result = new Date(date + "T00:00:00.000Z");
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function recentStockChanges(history: string, asOf: ISODate): { count: number; lastChangedAt: ISODate | null } {
  let count = 0;
  let lastChangedAt: ISODate | null = null;
  for (let day = 1; day < history.length; day += 1) {
    const previous = history[day - 1];
    const current = history[day];
    if (previous === "-" || current === "-" || previous === current) continue;
    count += 1;
    lastChangedAt = dateAtOffset(asOf, day - 29);
  }
  return { count, lastChangedAt };
}

function commonCategory(children: readonly SkuStockView[]): string {
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.category, (counts.get(child.category) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0]))[0]?.[0] ?? "";
}

/** Parent rows exist only in the query result; they are never inventory entities or persisted views. */
export function parentStockRows(rows: readonly SkuStockView[], asOf: ISODate): ParentStockRows {
  const existingSkus = new Set(rows.map((row) => row.sku));
  const childrenByParent = new Map<string, SkuStockView[]>();
  for (const row of rows) {
    if (!row.parent_sku || existingSkus.has(row.parent_sku)) continue;
    const children = childrenByParent.get(row.parent_sku) ?? [];
    children.push(row);
    childrenByParent.set(row.parent_sku, children);
  }

  const parentRows = [...childrenByParent].sort(([a], [b]) => compareKeys(a, b)).map(([sku, children]) => {
    children.sort((a, b) => compareKeys(a.sku, b.sku));
    const first = children[0]!;
    const history = parentHistory(children);
    const changes = recentStockChanges(history, asOf);
    return {
      ...first,
      sku,
      variant_title: null,
      category: commonCategory(children),
      price: Math.min(...children.map((child) => child.price)),
      stock_status: parentStatus(children),
      since: asOf,
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
    } satisfies SkuStockView;
  });
  const groupedChildren = new Set([...childrenByParent.values()].flatMap((children) => children.map((child) => child.sku)));
  return { rows: [...parentRows, ...rows.filter((row) => !groupedChildren.has(row.sku))], childrenByParent };
}
