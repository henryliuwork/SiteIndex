import { parseDocument } from "htmlparser2";
import { XMLParser } from "fast-xml-parser";
import type { SiteConfig, StockStatus } from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { FeedError, type FeedSnapshot, type SnapshotResult } from "./gmc-feed";

type Row = Record<string, unknown>;
type Node = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: Node[] };
type WooSite = Pick<SiteConfig, "base_url" | "currency" | "sitemaps" | "crawl">;
type PageProduct = {
  sku: string; product_id: string; handle: string; title: string; variant_title: string | null;
  url: string; category: string; categories: string[]; price: number | null;
  compare_at_price: number | null; currency: string; image_url: string | null;
  stock_status: StockStatus; qty: number | null; parent_sku?: string;
};
const XML = new XMLParser({ removeNSPrefix: true, parseTagValue: false, trimValues: true });
const MAX_SITEMAPS = 40;

export interface WooHtmlSnapshotResult extends SnapshotResult {
  emptyReason: string | null;
  warnings: string[];
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function list(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function nodes(root: Node, match: (node: Node) => boolean): Node[] {
  return [...(match(root) ? [root] : []), ...(root.children ?? []).flatMap((child) => nodes(child, match))];
}
function text(root: Node): string { return root.type === "text" ? root.data ?? "" : (root.children ?? []).map(text).join(""); }
function categorySlug(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
}
function schemaType(value: unknown, expected: string): boolean {
  return list(value).some((item) => string(item).split(/[\/#]/u).at(-1)?.toLowerCase() === expected.toLowerCase());
}
function sameOrigin(value: unknown, base: URL): string {
  try {
    const url = new URL(string(value), base);
    return string(value) && url.origin === base.origin && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
function imageUrl(value: unknown, base: URL): string | null {
  try {
    const url = new URL(string(value), base);
    return string(value) && ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function price(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : string(value).replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
function stock(value: unknown): StockStatus {
  const state = string(value).split(/[\/#]/u).at(-1)?.toLowerCase() ?? "";
  if (state === "instock" || state === "limitedavailability") return "in_stock";
  if (state === "outofstock" || state === "soldout" || state === "discontinued") return "out_of_stock";
  if (state === "preorder" || state === "presale" || state === "backorder") return "preorder";
  return "unknown";
}

function productNodes(html: string): { root: Node; products: { product: Row; group: Row }[] } {
  const root = parseDocument(html) as unknown as Node;
  const products: { product: Row; group: Row }[] = [];
  for (const script of nodes(root, (node) => node.name === "script" && node.attribs?.type?.toLowerCase() === "application/ld+json")) {
    try {
      const visit = (value: unknown, group: Row = {}) => {
        for (const item of list(value)) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const row = record(item);
          if (schemaType(row["@type"], "Product")) products.push({ product: row, group });
          visit(row["@graph"]);
          visit(row.hasVariant, schemaType(row["@type"], "ProductGroup") ? row : group);
        }
      };
      visit(JSON.parse(text(script)));
    } catch { /* malformed JSON-LD can still fall back to WooCommerce DOM */ }
  }
  return { root, products };
}

function pageStock(root: Node, product: Row): StockStatus | undefined {
  const offer = record(list(product.offers)[0]);
  const fromSchema = stock(offer.availability);
  if (fromSchema !== "unknown") return fromSchema;
  const stockNode = nodes(root, (node) => (node.attribs?.class ?? "").split(/\s+/u).includes("stock"))[0];
  const classes = (stockNode?.attribs?.class ?? "").split(/\s+/u);
  const state = classes.find((item) => ["in-stock", "out-of-stock", "available-on-backorder"].includes(item));
  const fromDom = stock(state?.replace("available-on-backorder", "backorder").replaceAll("-", ""));
  return fromDom === "unknown" ? undefined : fromDom;
}

export function wooPageStockStatus(html: string): StockStatus | undefined {
  const { root, products } = productNodes(html);
  return pageStock(root, products[0]?.product ?? {});
}

function pageProducts(html: string, url: string, site: WooSite): PageProduct[] {
  const { root, products } = productNodes(html);
  const named = (name: string) => nodes(root, (node) => node.name === name);
  const withClass = (name: string) => nodes(root, (node) => (node.attribs?.class ?? "").split(/\s+/u).includes(name));
  const titleNode = withClass("product_title")[0];
  if (!products.length && !titleNode) return [];
  const priceNode = withClass("price")[0];
  const amounts = priceNode ? nodes(priceNode, (node) => (node.attribs?.class ?? "").split(/\s+/u).includes("amount")) : [];
  const saleNode = priceNode ? nodes(priceNode, (node) => node.name === "ins")[0] : undefined;
  const saleAmount = saleNode ? nodes(saleNode, (node) => (node.attribs?.class ?? "").split(/\s+/u).includes("amount"))[0] : undefined;
  const priceText = saleAmount ? text(saleAmount) : amounts.length === 1 ? text(amounts[0]!) :
    amounts.length ? "" : text(priceNode ?? { type: "text", data: "" });
  const tokens = priceText.match(/\d[\d,.]*/gu) ?? [];
  const domPrice = tokens.length === 1 ? tokens[0] : "";
  const categoryLink = withClass("posted_in")[0];
  const categoryName = categoryLink ? nodes(categoryLink, (node) => node.name === "a").map(text)[0] : "";
  const gallery = withClass("woocommerce-product-gallery")[0];
  const galleryImage = gallery ? nodes(gallery, (node) => node.name === "img")[0] : undefined;
  return (products.length ? products : [{ product: {}, group: {} }]).map(({ product, group }) => {
    const offer = record(list(product.offers)[0]);
    const sku = string(product.sku) || (products.length ? "" : text(withClass("sku")[0] ?? { type: "text", data: "" }).trim());
    const name = string(group.name) || string(product.name) || text(titleNode ?? named("h1")[0] ?? { type: "text", data: "" }).trim();
    const current = price(offer.price ?? record(offer.priceSpecification).price ?? (products.length ? "" : domPrice));
    const category = categorySlug(string(product.category) || string(group.category) || categoryName || "");
    const image = list(product.image)[0] ?? list(group.image)[0];
    const mainImage = imageUrl(galleryImage?.attribs?.["data-large_image"]
      || galleryImage?.attribs?.["data-large-image"] || galleryImage?.attribs?.src
      || (typeof image === "string" ? image : record(image).url)
      || withClass("wp-post-image")[0]?.attribs?.src, new URL(site.base_url));
    const parent = record(product.isVariantOf);
    const parentSku = string(group.sku) || string(group.productGroupID) || string(parent.sku);
    return {
      sku, product_id: string(group.productGroupID) || string(group.productID) || string(product.productID) || sku,
      handle: new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? sku,
      title: name || sku, variant_title: parentSku && string(product.name) !== name ? string(product.name) || null : null, url,
      category: category || "uncategorized", categories: category ? [category] : [],
      price: current, compare_at_price: null,
      currency: string(offer.priceCurrency) || site.currency,
      image_url: mainImage, stock_status: pageStock(root, product) ?? "unknown", qty: null,
      ...(parentSku ? { parent_sku: parentSku } : {}),
    };
  });
}

async function textResponse(url: string, accept: string): Promise<string> {
  let response: Response;
  try { response = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(12_000), redirect: "manual" }); }
  catch { throw new FeedError("FEED_FETCH_FAILED", "商品 Sitemap 或页面抓取失败，未写入不完整快照。"); }
  if (response.status === 404 || response.status === 410) return "";
  if (!response.ok) throw new FeedError("FEED_FETCH_FAILED", `商品 Sitemap 或页面返回 HTTP ${response.status}，未写入不完整快照。`);
  return response.text();
}

async function productUrls(site: WooSite): Promise<string[]> {
  const base = new URL(site.base_url);
  const defaults = ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"];
  const queue = (site.sitemaps.length ? site.sitemaps : defaults)
    .map((url) => sameOrigin(url, base)).filter(Boolean);
  const visited = new Set<string>();
  const maps: { url: string; locations: string[] }[] = [];
  let attemptedDefaults = !site.sitemaps.length;
  while ((queue.length || (!attemptedDefaults && !maps.length)) && visited.size < MAX_SITEMAPS) {
    if (!queue.length) {
      queue.push(...defaults.map((url) => sameOrigin(url, base)).filter(Boolean));
      attemptedDefaults = true;
    }
    const sitemap = queue.shift()!;
    if (visited.has(sitemap)) continue;
    visited.add(sitemap);
    const xml = await textResponse(sitemap, "application/xml,text/xml");
    if (!xml) continue;
    let parsed: Row;
    try { parsed = record(XML.parse(xml)); }
    catch { throw new FeedError("FEED_FETCH_FAILED", "商品 Sitemap XML 格式无效。"); }
    const index = record(parsed.sitemapindex);
    const children = list(index.sitemap).map((item) => sameOrigin(record(item).loc, base)).filter(Boolean).sort(compareKeys);
    if (children.length) {
      const productChildren = children.filter((child) => /product(?![-_]?cat)/iu.test(new URL(child).pathname));
      queue.push(...(productChildren.length ? productChildren : children));
      continue;
    }
    const locations = list(record(parsed.urlset).url).map((item) => sameOrigin(record(item).loc, base)).filter(Boolean);
    if (locations.length) maps.push({ url: sitemap, locations });
  }
  if (queue.length) throw new FeedError("FEED_FETCH_FAILED", "商品 Sitemap 数量超过安全上限，未写入不完整快照。");
  const productMaps = maps.filter((map) => /product(?![-_]?cat)/iu.test(new URL(map.url).pathname));
  const source = productMaps.length ? productMaps : maps;
  const urls = [...new Set(source.flatMap((map) => map.locations).map((value) => {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("attribute_pa_")) url.searchParams.delete(key);
    return url.href;
  }))].sort(compareKeys);
  const limit = Math.max(1, Math.floor(site.crawl.max_pages ?? 2_000));
  if (urls.length > limit) throw new FeedError("FEED_FETCH_FAILED", "商品页面超过配置抓取上限，未写入不完整快照。");
  return urls;
}

/** Read-only fallback; returns a complete priced snapshot or a readable empty reason. */
export async function collectWooSitemapHtml(site: WooSite): Promise<WooHtmlSnapshotResult> {
  const urls = await productUrls(site);
  const rows: FeedSnapshot[] = [];
  const stats: Record<string, number> = {};
  const filtered = { no_id: 0, missing_price_or_link: 0, duplicate: 0 };
  const seen = new Set<string>();
  for (const [index, url] of urls.entries()) {
    const delay = Math.max(0, site.crawl.rate_limit_ms);
    if (delay && index > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const html = await textResponse(url, "text/html");
    if (!html) continue;
    for (const row of pageProducts(html, url, site)) {
      if (!row.sku) { filtered.no_id += 1; continue; }
      if (row.price === null) { filtered.missing_price_or_link += 1; continue; }
      if (seen.has(row.sku)) { filtered.duplicate += 1; continue; }
      seen.add(row.sku);
      stats[row.stock_status] = (stats[row.stock_status] ?? 0) + 1;
      rows.push({ ...row, price: row.price });
    }
  }
  rows.sort((left, right) => compareKeys(left.sku, right.sku));
  Object.assign(stats, filtered);
  const warnings = filtered.missing_price_or_link
    ? [`${filtered.missing_price_or_link} 条商品缺少有效价格，已跳过；询价商品暂未入库。`] : [];
  const emptyReason = rows.length ? null : urls.length
    ? `商品页面已抓取，但没有可入库商品（无 SKU ${filtered.no_id}，无有效价格 ${filtered.missing_price_or_link}）。`
    : "没有在商品 Sitemap 中发现可抓取的商品页面。";
  return { rows, stats, filtered, warnings, emptyReason };
}
