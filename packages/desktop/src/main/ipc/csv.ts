import { app, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SiteIndexError } from "@siteindex/shared";
import type { ProductView, SkuStockView } from "@siteindex/shared";

export const INVENTORY_CSV_COLUMNS = [
  "sku",
  "title",
  "variant_title",
  "category",
  "price",
  "stock_status",
  "since",
  "days_in_status",
  "online_rate_7d",
  "online_rate_30d",
  "history_30d",
  "changes_30d",
  "last_change",
  "last_change_at",
] as const satisfies readonly (keyof SkuStockView)[];

export const PRODUCT_CSV_COLUMNS = [
  "handle",
  "product_id",
  "title",
  "url",
  "category",
  "categories",
  "price_min",
  "price_max",
  "compare_at_max",
  "currency",
  "on_sale",
  "image_url",
  "image_source",
  "variant_count",
  "skus",
  "in_stock_variants",
  "stock_status",
  "stock_since",
  "tags",
  "priority",
  "exclude_edm",
  "last_featured",
  "days_since_featured",
  "first_seen",
  "status",
] as const satisfies readonly (keyof ProductView)[];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value)
    ? value.join(";")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvContent<T extends object>(rows: readonly T[], columns: readonly string[]): string {
  return `\uFEFF${[
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell((row as Record<string, unknown>)[column])).join(",")),
  ].join("\r\n")}`;
}

export async function saveCsv(
  title: string,
  defaultName: string,
  rows: readonly object[],
  columns: readonly string[],
): Promise<string> {
  const result = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(app.getPath("downloads"), defaultName),
    filters: [{ name: "CSV 文件", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) {
    throw { code: "UNKNOWN", message: "已取消 CSV 导出。" } satisfies SiteIndexError;
  }
  await writeFile(result.filePath, csvContent(rows, columns), "utf8");
  return result.filePath;
}
