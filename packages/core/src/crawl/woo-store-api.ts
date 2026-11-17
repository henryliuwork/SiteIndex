import type { SiteConfig, StockStatus } from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { FeedError, type FeedSnapshot, type SnapshotResult } from "./gmc-feed";

type Row = Record<string, unknown>;
type WooSite = Pick<SiteConfig, "base_url" | "currency">;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

export interface WooStoreSnapshotResult extends SnapshotResult {
  filtered: SnapshotResult["filtered"] & { missing_price: number; missing_link: number };
  emptyReason: string | null;
  warnings: string[];
}

function record(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identifier(value: unknown): string {
  return (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^\d+$/u.test(value)) ? String(value) : "";
}

function absoluteUrl(value: unknown, base: string): string {
  try {
    const url = new URL(string(value), base);
    return string(value) && (url.protocol === "https:" || url.protocol === "http:") ? url.href : "";
  } catch { return ""; }
}

function minorPrice(value: unknown, unit: unknown): number | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : string(value);
  if (!/^\d+$/u.test(text) || typeof unit !== "number" || !Number.isInteger(unit) || unit < 0 || unit > 6) return null;
  const minor = Number(text);
  return Number.isSafeInteger(minor) ? minor / (10 ** unit) : null;
}

function stockStatus(product: Row): StockStatus {
  if (product.is_on_backorder === true) return "preorder";
  if (product.is_in_stock === false) return "out_of_stock";
  if (product.is_in_stock === true && product.is_purchasable !== false) return "in_stock";
  return "unknown";
}

function parentId(product: Row): string {
  const direct = identifier(product.parent_id ?? product.parent) || identifier(record(product.parent).id);
  if (direct) return direct;
  const up = record(product._links).up;
  const href = Array.isArray(up) ? string(record(up[0]).href) : "";
  return /\/products\/(\d+)(?:\/?(?:\?|$))/u.exec(href)?.[1] ?? "";
}

async function paged(base: string, resource: string, variation = false, optional = false): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`wp-json/wc/store/v1/${resource}`, `${base.replace(/\/$/u, "")}/`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PAGE_SIZE));
    if (variation) url.searchParams.set("type", "variation");
    let response: Response;
    try { response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }); }
    catch {
      if (optional) return [];
      throw new FeedError("FEED_FETCH_FAILED", "WooCommerce Store API 请求失败；可尝试商品 Sitemap 回退采集。");
    }
    if (!response.ok) {
      if (optional) return [];
      throw new FeedError("FEED_FETCH_FAILED", `WooCommerce Store API 返回 HTTP ${response.status}；可尝试商品 Sitemap 回退采集。`);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      if (optional) return [];
      throw new FeedError("FEED_FETCH_FAILED", "WooCommerce Store API 返回的不是有效 JSON。");
    }
    if (!Array.isArray(payload)) {
      if (optional) return [];
      throw new FeedError("FEED_FETCH_FAILED", "WooCommerce Store API 返回的商品列表格式无效。");
    }
    rows.push(...payload.filter((item): item is Row => item !== null && typeof item === "object" && !Array.isArray(item)));
    const totalPages = Number(response.headers.get("x-wp-totalpages"));
    const hasTotalPages = Number.isInteger(totalPages) && totalPages > 0;
    if (hasTotalPages ? page >= totalPages : payload.length < PAGE_SIZE) return rows;
  }
  throw new FeedError("FEED_FETCH_FAILED", "WooCommerce Store API 分页超过安全上限，未写入不完整的商品数据。");
}

/** Public Store API data only; never invents a price or a stock row for a variable parent. */
export async function collectWooStoreApi(site: WooSite): Promise<WooStoreSnapshotResult> {
  const [products, variations, categoryRows] = await Promise.all([
    paged(site.base_url, "products"),
    paged(site.base_url, "products", true),
    paged(site.base_url, "products/categories", false, true),
  ]);
  const parents = new Map(products.flatMap((item) => {
    const id = identifier(item.id);
    return id ? [[id, item] as const] : [];
  }));
  const categories = new Map(categoryRows.flatMap((item) => {
    const id = identifier(item.id);
    return id ? [[id, string(item.slug)] as const] : [];
  }));
  const variationParents = new Set(variations.map(parentId).filter(Boolean));
  const candidates = [
    ...products.filter((item) => !variationParents.has(identifier(item.id))),
    ...variations,
  ].sort((a, b) => compareKeys(identifier(a.id), identifier(b.id)));
  const filtered = { no_id: 0, missing_price_or_link: 0, duplicate: 0, missing_price: 0, missing_link: 0 };
  const stats: Record<string, number> = {};
  const seen = new Set<string>();
  const rows: FeedSnapshot[] = [];
  for (const item of candidates) {
    const sku = string(item.sku);
    if (!sku) { filtered.no_id += 1; continue; }
    if (seen.has(sku)) { filtered.duplicate += 1; continue; }
    seen.add(sku);
    const parent = parents.get(parentId(item));
    const prices = record(item.prices);
    const price = minorPrice(prices.price, prices.currency_minor_unit);
    const regular = minorPrice(prices.regular_price, prices.currency_minor_unit);
    const url = absoluteUrl(item.permalink, site.base_url);
    if (price === null || !url) {
      filtered.missing_price_or_link += 1;
      if (price === null) filtered.missing_price += 1;
      if (!url) filtered.missing_link += 1;
      continue;
    }
    const categoryRows = Array.isArray(item.categories) && item.categories.length ? item.categories
      : Array.isArray(parent?.categories) ? parent.categories : [];
    const slugs = [...new Set(categoryRows.map((category) => {
      const value = record(category);
      return string(value.slug) || categories.get(identifier(value.id)) || "";
    }).filter(Boolean))].sort(compareKeys);
    const groupId = parentId(item);
    const image = (Array.isArray(item.images) && item.images.length ? item.images : Array.isArray(parent?.images) ? parent.images : [])[0];
    const parentSku = groupId ? string(parent?.sku) || `wc-parent-${groupId}` : "";
    const handle = string(parent?.slug) || string(item.slug) || new URL(url).pathname.split("/").filter(Boolean).at(-1) || sku;
    const status = stockStatus(item);
    stats[status] = (stats[status] ?? 0) + 1;
    rows.push({
      sku, product_id: groupId || identifier(item.id), handle,
      title: string(parent?.name) || string(item.name) || sku,
      variant_title: parent ? string(item.variation) || (string(item.name) !== string(parent.name) ? string(item.name) : "") || null : null,
      url, category: slugs[0] ?? "uncategorized", categories: slugs,
      price, compare_at_price: regular !== null && regular > price ? regular : null,
      currency: string(prices.currency_code) || site.currency,
      image_url: absoluteUrl(record(image).src, site.base_url) || null,
      stock_status: status, qty: null,
      ...(parentSku ? { parent_sku: parentSku } : {}),
    });
  }
  rows.sort((a, b) => compareKeys(a.sku, b.sku));
  Object.assign(stats, filtered);
  const emptyReason = rows.length ? null : filtered.missing_price
    ? `Store API 读取到商品，但 ${filtered.missing_price} 条缺少有效价格；询价商品暂未入库。`
    : `Store API 没有可入库商品（无 SKU ${filtered.no_id}，缺链接 ${filtered.missing_link}，重复 SKU ${filtered.duplicate}）。`;
  const warnings = filtered.missing_price
    ? [`${filtered.missing_price} 条商品缺少有效价格，已跳过；询价商品暂未入库。`] : [];
  return { rows, stats, filtered, emptyReason, warnings };
}
