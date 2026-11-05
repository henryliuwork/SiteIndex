import type { ProductView, SkuGroupingRule, SkuRecord, SkuStockView, StockStatus } from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { groupSkuIds } from "../inventory/sku-grouping";

function groupedStockStatus(statuses: readonly StockStatus[]): StockStatus {
  if (statuses.some((status) => status === "in_stock")) return "in_stock";
  if (statuses.length > 0 && statuses.every((status) => status === "out_of_stock")) return "out_of_stock";
  if (statuses.some((status) => status === "preorder")) return "preorder";
  return "unknown";
}

function productStockStatus(statuses: readonly StockStatus[]): StockStatus {
  if (statuses.includes("in_stock")) return "in_stock";
  if (statuses.includes("preorder")) return "preorder";
  if (statuses.includes("out_of_stock")) return "out_of_stock";
  return "unknown";
}

function commonValue(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || compareKeys(left[0], right[0]))[0]?.[0] ?? "";
}

function subsetProductRow(
  row: ProductView,
  skuIds: readonly string[],
  skuById: ReadonlyMap<string, SkuRecord>,
  stockBySku: ReadonlyMap<string, SkuStockView>,
): ProductView {
  if (skuIds.length === row.skus.length) return { ...row, row_kind: "single", parent_sku: null };
  const selected = skuIds.flatMap((sku) => {
    const record = skuById.get(sku);
    return record ? [record] : [];
  });
  if (selected.length === 0) return { ...row, row_kind: "single", parent_sku: null };
  const statuses = selected.map((sku) => stockBySku.get(sku.sku)?.stock_status ?? "unknown");
  const prices = selected.map((sku) => sku.price);
  const comparePrices = selected.flatMap((sku) => sku.compare_at_price === null ? [] : [sku.compare_at_price]);
  const categories = [...new Set(selected.flatMap((sku) => sku.categories ?? (sku.category ? [sku.category] : [])))].sort(compareKeys);
  return {
    ...row,
    category: selected[0]!.category,
    categories,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    compare_at_max: comparePrices.length ? Math.max(...comparePrices) : null,
    on_sale: selected.some((sku) => sku.compare_at_price !== null && sku.compare_at_price > sku.price),
    variant_count: selected.length,
    skus: selected.map((sku) => sku.sku),
    in_stock_variants: statuses.filter((status) => status === "in_stock").length,
    stock_status: productStockStatus(statuses),
    row_kind: "single",
    parent_sku: null,
  };
}

function parentProductRow(
  parent: string,
  childSkus: readonly string[],
  productBySku: ReadonlyMap<string, ProductView>,
  skuById: ReadonlyMap<string, SkuRecord>,
  stockBySku: ReadonlyMap<string, SkuStockView>,
): ProductView | null {
  const source = childSkus.flatMap((sku) => {
    const row = productBySku.get(sku);
    return row ? [{ sku, row }] : [];
  })[0];
  if (!source) return null;
  const records = childSkus.flatMap((sku) => {
    const record = skuById.get(sku);
    return record ? [record] : [];
  });
  const statuses = childSkus.map((sku) => stockBySku.get(sku)?.stock_status ?? "unknown");
  const sourceRows = [...new Set(childSkus.flatMap((sku) => {
    const row = productBySku.get(sku);
    return row ? [row] : [];
  }))];
  const categories = [...new Set(records.flatMap((record) => record.categories ?? (record.category ? [record.category] : [])))].sort(compareKeys);
  const tags = [...new Set(sourceRows.flatMap((row) => row.tags))].sort(compareKeys);
  const prices = records.map((record) => record.price);
  const comparePrices = records.flatMap((record) => record.compare_at_price === null ? [] : [record.compare_at_price]);
  const stockStatus = groupedStockStatus(statuses);
  const stockSince = childSkus.flatMap((sku) => {
    const stock = stockBySku.get(sku);
    return stock?.stock_status === stockStatus ? [stock.since] : [];
  }).sort(compareKeys)[0] ?? null;
  return {
    ...source.row,
    handle: source.row.handle,
    product_id: parent,
    category: commonValue(records.map((record) => record.category)),
    categories,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    compare_at_max: comparePrices.length ? Math.max(...comparePrices) : null,
    currency: records[0]?.currency ?? source.row.currency,
    on_sale: records.some((record) => record.compare_at_price !== null && record.compare_at_price > record.price),
    variant_count: childSkus.length,
    skus: [...childSkus],
    in_stock_variants: statuses.filter((status) => status === "in_stock").length,
    row_kind: "parent",
    parent_sku: null,
    stock_status: stockStatus,
    stock_since: stockSince,
    tags,
    priority: sourceRows.flatMap((row) => row.priority === null ? [] : [row.priority]).reduce<number | null>((max, value) => Math.max(max ?? value, value), null),
    exclude_edm: sourceRows.some((row) => row.exclude_edm === 1) ? 1 : 0,
    status: "active",
  };
}

/** Adds query-only product parent rows without changing the persisted products view. */
export function groupProductRows(
  products: readonly ProductView[],
  skus: readonly SkuRecord[],
  stockRows: readonly SkuStockView[],
  rule: SkuGroupingRule,
  parentOnly: boolean,
): ProductView[] {
  const activeSkus = skus.filter((sku) => sku.status === "active");
  const grouping = groupSkuIds(activeSkus.map((sku) => sku.sku), rule);
  const skuById = new Map(activeSkus.map((sku) => [sku.sku, sku]));
  const stockBySku = new Map(stockRows.map((row) => [row.sku, row]));
  const productBySku = new Map<string, ProductView>();
  for (const row of [...products].sort((left, right) => compareKeys(left.handle, right.handle))) {
    for (const sku of row.skus) if (!productBySku.has(sku)) productBySku.set(sku, row);
  }

  if (!parentOnly) {
    return products.map((row) => {
      const parents = [...new Set(row.skus.flatMap((sku) => {
        const parent = grouping.parentByChild.get(sku);
        return parent ? [parent] : [];
      }))];
      if (row.skus.length > 0 && parents.length === 1 && row.skus.every((sku) => grouping.parentByChild.get(sku) === parents[0])) {
        return { ...row, row_kind: "child", parent_sku: parents[0]!, variant_count: null, in_stock_variants: null };
      }
      return { ...row, row_kind: "single", parent_sku: null };
    });
  }

  const parentRows = grouping.groups.flatMap(({ parent, children }) => {
    const row = parentProductRow(parent, children, productBySku, skuById, stockBySku);
    return row ? [row] : [];
  });
  const singles: ProductView[] = [];
  for (const row of products) {
    const ungrouped = row.skus.filter((sku) => !grouping.parentByChild.has(sku));
    if (ungrouped.length > 0) singles.push(subsetProductRow(row, ungrouped, skuById, stockBySku));
  }
  return [...parentRows, ...singles].sort((left, right) => compareKeys(left.handle, right.handle));
}
