import type { ProductView, SkuStockView } from "@siteindex/shared";

export interface ProductManagementRow {
  id: string;
  product: ProductView;
  sku: string | null;
  kind: "parent" | "child" | "single";
  stock: SkuStockView | null;
}

export function mergeProductAndStockRows(
  products: readonly ProductView[],
  stockRows: readonly SkuStockView[],
  requireStock: boolean,
): ProductManagementRow[] {
  const stocksBySku = new Map(stockRows.map((row) => [row.sku, row]));
  return products.flatMap((product) => {
    const isParent = product.row_kind === "parent";
    const skus: (string | null)[] = isParent
      ? [product.product_id]
      : product.skus.length > 0
        ? [...new Set(product.skus)]
        : [null];
    return skus.flatMap((sku) => {
      const stock = sku ? stocksBySku.get(sku) ?? null : null;
      if (requireStock && !stock) return [];
      const kind = isParent ? "parent" : product.row_kind === "child" ? "child" : "single";
      return [{ id: `${product.handle}:${sku ?? "no-sku"}`, product, sku, kind, stock }];
    });
  });
}

export function matchesProductManagementSearch(row: ProductManagementRow, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  const searchable = [
    row.product.title,
    row.product.handle,
    row.product.product_id,
    row.product.category,
    ...row.product.categories,
    ...row.product.tags,
    ...row.product.skus,
    row.sku ?? "",
    row.stock?.title ?? "",
    row.stock?.variant_title ?? "",
  ].join(" ").toLocaleLowerCase("zh-CN");
  return searchable.includes(needle);
}

export function formatProductPrice(row: ProductManagementRow): string {
  if (row.kind === "parent") {
    if (row.product.price_min === null) return "—";
    if (row.product.price_max === null || row.product.price_min === row.product.price_max) return row.product.price_min.toFixed(2);
    return row.product.price_min.toFixed(2) + "–" + row.product.price_max.toFixed(2);
  }
  if (row.stock) return row.stock.price.toFixed(2);
  if (row.product.price_min === null) return "—";
  if (row.product.price_max === null || row.product.price_min === row.product.price_max) return row.product.price_min.toFixed(2);
  return row.product.price_min.toFixed(2) + "–" + row.product.price_max.toFixed(2);
}

export function formatInStockVariants(row: ProductManagementRow): string {
  if (row.kind !== "parent" || typeof row.product.in_stock_variants !== "number" || typeof row.product.variant_count !== "number") return "—";
  return `${row.product.in_stock_variants}/${row.product.variant_count}`;
}
