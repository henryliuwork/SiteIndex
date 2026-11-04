import type { ISODate, SkuStockView, StockStatus } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

export interface ParentStockRows {
  rows: SkuStockView[];
  childrenByParent: Map<string, SkuStockView[]>;
}

function parentStatus(children: readonly SkuStockView[]): StockStatus {
  if (children.some((child) => child.stock_status === "in_stock")) return "in_stock";
  if (children.every((child) => child.stock_status === "out_of_stock")) return "out_of_stock";
  if (children.some((child) => child.stock_status === "preorder")) return "preorder";
  return "unknown";
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
    return {
      ...first,
      sku,
      variant_title: null,
      category: commonCategory(children),
      price: Math.min(...children.map((child) => child.price)),
      stock_status: parentStatus(children),
      since: asOf,
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
    } satisfies SkuStockView;
  });
  const groupedChildren = new Set([...childrenByParent.values()].flatMap((children) => children.map((child) => child.sku)));
  return { rows: [...parentRows, ...rows.filter((row) => !groupedChildren.has(row.sku))], childrenByParent };
}
