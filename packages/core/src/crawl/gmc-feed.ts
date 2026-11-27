import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { EXIT, type SiteIndexErrorCode, type SkuAttributes, type StockStatus } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";

export type { StockStatus };

export type FeedItem = Record<string, string | string[] | undefined>;
export type FeedSnapshot = Record<string, unknown> & {
  sku: string;
  product_id: string;
  handle: string;
  title: string;
  variant_title: string | null;
  url: string;
  category: string;
  categories: string[];
  product_type_raw?: string | null;
  description?: string | null;
  highlights?: string[];
  attributes?: SkuAttributes;
  custom_labels?: (string | null)[];
  price: number;
  compare_at_price: number | null;
  currency: string;
  image_url: string | null;
  stock_status: StockStatus;
  qty: number | null;
};
export interface FeedSiteConfig {
  base_url: string;
  currency?: string;
  timezone?: string;
  crawl?: {
    feed_url?: string | string[];
    sku_field?: string;
    category_source?: string;
    category_depth?: number;
    category_map?: Record<string, string>;
    user_agent?: string;
    overrides?: Record<string, Record<string, unknown>>;
  };
}

export class FeedError extends Error {
  readonly code: SiteIndexErrorCode;
  readonly exitCode: number;
  constructor(code: SiteIndexErrorCode, message: string, exitCode = EXIT.SOURCE_FAILED) {
    super(message);
    this.name = "FeedError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const STOCK_MAP: Record<string, StockStatus> = {
  in_stock: "in_stock", "in stock": "in_stock", instock: "in_stock",
  out_of_stock: "out_of_stock", "out of stock": "out_of_stock", outofstock: "out_of_stock",
  preorder: "preorder", "pre-order": "preorder", backorder: "preorder", "back order": "preorder",
};
const VARIANT_ATTRIBUTES = ["color", "size", "material", "pattern"] as const;
const TRACKING_QUERY = /^(utm_|gclid$|gbraid$|wbraid$|srsltid$|fbclid$|mc_|_ga$)/i;

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  transformTagName: (name) => name.toLowerCase(),
  isArray: (name) => name === "item" || name === "entry" || name === "product",
});

const HTML_FEED_MESSAGE = "这个地址返回的是网页而不是商品 feed（可能需要登录，或是 Google 表格/后台页面的链接）。请填写 Merchant Center 数据源中的'抓取网址'。";

function xmlSnippet(source: string, line: number): string {
  const nearby = source.replace(/^\uFEFF/, "").split(/\r?\n/)[Math.max(0, line - 1)]?.trim() ?? "";
  return nearby.slice(0, 160);
}

function parseErrorMessage(source: string, line: number, column: number, reason: string): string {
  const snippet = xmlSnippet(source, line);
  return `Feed XML 第 ${line} 行第 ${column} 列解析失败：${reason}${snippet ? `；附近内容：${snippet}` : ""}`;
}

function nodeText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as Record<string, unknown>)["#text"];
  return typeof text === "string" || typeof text === "number" ? String(text).trim() : "";
}

function linkValue(value: unknown): string {
  const links = Array.isArray(value) ? value : [value];
  const entries = links.filter((link): link is Record<string, unknown> => typeof link === "object" && link !== null && !Array.isArray(link));
  const alternate = entries.find((link) => String(link["@_rel"] ?? "").toLowerCase() === "alternate");
  const selected = alternate ?? entries[0];
  if (selected) return String(selected["@_href"] ?? nodeText(selected));
  return nodeText(links[0]);
}

function xmlRecord(value: unknown): FeedItem {
  const row: FeedItem = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return row;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (name.startsWith("@_")) continue;
    const key = name.toLowerCase();
    if (key === "link") {
      const link = linkValue(raw);
      if (link) row.link = link;
      continue;
    }
    const values = Array.isArray(raw) ? raw.map(nodeText) : [nodeText(raw)];
    if (key === "additional_image_link" || key === "product_type" || key === "product_highlight") {
      const nonempty = values.filter(Boolean);
      if (!nonempty.length) continue;
      row[key] = nonempty[0];
      if (nonempty.length > 1) row[`${key}_all`] = nonempty;
    } else if (!Object.hasOwn(row, key)) {
      row[key] = values[0] ?? "";
    }
  }
  return row;
}

function productRecord(value: unknown): FeedItem {
  const row = xmlRecord(value);
  for (const [target, aliases] of Object.entries({
    id: ["sku"], title: ["name"], link: ["product_url", "url", "permalink"],
    price: ["regular_price"], image_link: ["image_url"], availability: ["stock_status"],
  })) {
    if (row[target]) continue;
    const alias = aliases.find((key) => row[key]);
    if (alias) row[target] = row[alias];
  }
  return row;
}

function parseXmlItems(source: string): FeedItem[] {
  const validation = XMLValidator.validate(source);
  if (validation !== true) {
    const { line, col, msg } = validation.err;
    throw new FeedError("FEED_FETCH_FAILED", parseErrorMessage(source, line, col, msg));
  }

  let document: unknown;
  try {
    document = XML.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FeedError("FEED_FETCH_FAILED", parseErrorMessage(source, 1, 1, reason));
  }

  const root = Object.keys(document as Record<string, unknown>).find((key) => !key.startsWith("?")) ?? "";
  if (!["rss", "feed", "rdf", "products", "catalog"].includes(root)) {
    throw new FeedError("FEED_FETCH_FAILED", `Feed XML 根节点 <${root || "未知"}> 不是商品记录容器；需要 <item>、<entry> 或 <products><product>。`);
  }
  const items: FeedItem[] = [];
  const visit = (node: unknown, parent = ""): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
      if (name === "item" || name === "entry") {
        for (const record of Array.isArray(value) ? value : [value]) items.push(xmlRecord(record));
      } else if (name === "product" && parent === "products") {
        for (const record of Array.isArray(value) ? value : [value]) items.push(productRecord(record));
      } else visit(value, name);
    }
  };
  visit(document);
  return items;
}

function parseDelimited(source: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (quoted) throw new FeedError("FEED_FETCH_FAILED", "Feed TSV 引号未闭合。");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/^g:/, "").replaceAll(" ", "_");
}

function parseTabularItems(source: string): FeedItem[] {
  const withoutBom = source.replace(/^\uFEFF/, "");
  const first = withoutBom.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = first.split("\t").length - 1 >= first.split(",").length - 1 ? "\t" : ",";
  const table = parseDelimited(withoutBom, delimiter);
  const headers = table[0]?.map(normalizeHeader) ?? [];
  return table.slice(1).filter((row) => !(row.length === 1 && row[0] === ""))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? "").trim()])));
}

/** 解析 Google Merchant Center RSS、Atom 或带空格表头的 CSV/TSV。 */
export function parseFeed(data: string | Uint8Array): FeedItem[] {
  const source = (typeof data === "string" ? data : new TextDecoder().decode(data)).replace(/^\uFEFF/, "");
  if (source.trimStart().startsWith("<")) return parseXmlItems(source);
  return parseTabularItems(source);
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll("&", " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "uncategorized";
}

function cleanUrl(value: string | undefined, base?: string): string | null {
  if (!value) return null;
  let url: URL;
  try { url = base ? new URL(value.trim(), base) : new URL(value.trim()); }
  catch { return null; }
  const pairs: [string, string][] = [];
  for (const [key, val] of url.searchParams) if (val !== "" && !TRACKING_QUERY.test(key)) pairs.push([key, val]);
  const query = pairs.map(([key, val]) => `${encodeQuery(key)}=${encodeQuery(val)}`).join("&");
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname || "/"}${query ? `?${query}` : ""}`;
}

function encodeQuery(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

function parsePrice(value: string | undefined): [number | null, string | null] {
  if (!value) return [null, null];
  const currency = /\b([A-Z]{3})\b/.exec(value)?.[1] ?? null;
  let amount = /\d[\d.,]*/.exec(value)?.[0];
  if (!amount) return [null, currency];
  if (amount.includes(",") && amount.includes(".")) {
    amount = amount.lastIndexOf(".") > amount.lastIndexOf(",") ? amount.replaceAll(",", "") : amount.replaceAll(".", "").replace(",", ".");
  } else if (amount.includes(",")) {
    amount = amount.split(",").at(-1)?.length === 2 ? amount.replace(",", ".") : amount.replaceAll(",", "");
  }
  const parsed = Number(amount);
  return [Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null, currency];
}

function saleActive(value: string | undefined, today: string): boolean {
  if (!value || !value.includes("/")) return true;
  try {
    const [start, end] = value.split("/", 2).map((part) => part.trim().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) return true;
    const startTime = Date.parse(`${start}T00:00:00Z`);
    const endTime = Date.parse(`${end}T00:00:00Z`);
    return Number.isFinite(startTime) && Number.isFinite(endTime) && start! <= today && today <= end!;
  } catch { return true; }
}

function categoryOf(item: FeedItem, cfg: NonNullable<FeedSiteConfig["crawl"]>, url: string | null): [string, string[]] {
  const source = cfg.category_source ?? "product_type";
  const depth = Math.max(1, Number.parseInt(String(cfg.category_depth ?? 1), 10) || 1);
  const map = new Map(Object.entries(cfg.category_map ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  let segments: string[];
  if (source === "url_path" && url) {
    const parts = new URL(url).pathname.replace(/^\/+|\/+$/g, "").split("/").slice(0, -1)
      .map((part) => part.replace(/\.html$/i, ""));
    segments = parts.length ? parts : ["uncategorized"];
  } else {
    const raw = String(item[source === "google_product_category" ? "google_product_category" : "product_type"] ?? "");
    segments = raw.split(/\s*>\s*/).map((part) => part.trim()).filter(Boolean);
    if (!segments.length) segments = ["uncategorized"];
  }
  const selected = segments[Math.min(depth, segments.length) - 1] ?? "uncategorized";
  const main = map.get(selected.toLowerCase()) ?? map.get(slugify(selected)) ?? slugify(selected);
  const typeValues = [String(item.product_type ?? ""), ...(Array.isArray(item.product_type_all) ? item.product_type_all.slice(1) : [])];
  const categories = new Set<string>();
  for (const raw of typeValues) {
    const parts = String(raw).split(/\s*>\s*/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) continue;
    const category = parts[Math.min(depth, parts.length) - 1]!;
    categories.add(map.get(category.toLowerCase()) ?? slugify(category));
  }
  categories.add(main);
  return [main, [...categories].sort()];
}

function handleOf(item: FeedItem, url: string | null): string {
  if (url) {
    const last = new URL(url).pathname.replace(/\/+$/, "").split("/").at(-1) ?? "";
    const handle = last.replace(/\.(html?|php)$/i, "");
    if (handle) return handle.toLowerCase();
  }
  return slugify(String(item.item_group_id ?? item.id ?? ""));
}

function localDate(timezone?: string): string {
  if (!timezone) return new Date().toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export interface SnapshotResult {
  rows: FeedSnapshot[];
  stats: Record<string, number>;
  filtered: { no_id: number; missing_price_or_link: number; duplicate: number };
}

/** 用计数说明空快照，不把源站内容写入日志。 */
export function emptySnapshotReason(items: readonly FeedItem[], snapshot: SnapshotResult): string {
  if (snapshot.rows.length) return "";
  if (!items.length) return "Feed 中没有 <item>、<entry> 或 <products><product> 商品记录。";
  const { no_id, missing_price_or_link, duplicate } = snapshot.filtered;
  const blogEntries = items.filter((item) => item.pubdate || item.published || item.updated || item.guid);
  const priced = items.filter((item) => item.price || item.regular_price);
  if (blogEntries.length && !priced.length) return `疑似博客 RSS/Atom 订阅流，${items.length} 条文章均未提供商品价格；请填写商品 GMC Feed。`;
  if (missing_price_or_link) {
    const missingPrice = items.filter((item) => !item.price && !item.regular_price).length;
    const missingLink = items.filter((item) => !item.link && !item.mobile_link && !item.product_url && !item.url && !item.permalink).length;
    return `Feed 有 ${items.length} 条记录，但 ${missing_price_or_link} 条缺少有效价格或商品链接（缺价格 ${missingPrice}，缺链接 ${missingLink}）。`;
  }
  return `Feed 有 ${items.length} 条记录，但没有可用商品（无 SKU ${no_id}，重复 SKU ${duplicate}）。`;
}

/** 按 SKU 合并 site.json 的覆盖字段；daily 在写入主表前调用，快照原始文件保持 feed 原样。 */
export function applyFeedOverrides(
  rows: readonly FeedSnapshot[],
  overrides: Record<string, Record<string, unknown>> = {},
): FeedSnapshot[] {
  return rows.map((row) => ({ ...row, ...overrides[row.sku] }) as FeedSnapshot);
}

const SNAPSHOT_CANONICAL_KEYS = [
  "sku",
  "product_id",
  "handle",
  "title",
  "variant_title",
  "url",
  "category",
  "categories",
  "price",
  "compare_at_price",
  "currency",
  "image_url",
  "stock_status",
  "qty",
] as const;

const ATTRIBUTE_KEYS = [
  "color",
  "size",
  "material",
  "pattern",
  "gender",
  "age_group",
  "condition",
  "shipping_weight",
] as const;

function cleanPlainText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1).trimEnd()}…` : stripped;
}

function extractFeedHighlights(item: FeedItem): string[] | undefined {
  const rawList = Array.isArray(item.product_highlight_all)
    ? item.product_highlight_all
    : typeof item.product_highlight === "string" && item.product_highlight.trim()
      ? [item.product_highlight]
      : [];
  const cleaned = [...new Set(rawList.map((entry) => cleanPlainText(entry, 160)).filter((entry): entry is string => Boolean(entry)))].slice(0, 8);
  return cleaned.length ? cleaned : undefined;
}

function extractFeedAttributes(item: FeedItem): SkuAttributes | undefined {
  const attrs: SkuAttributes = {};
  let hasAny = false;
  for (const key of ATTRIBUTE_KEYS) {
    const val = cleanPlainText(item[key], 80);
    if (val) {
      attrs[key] = val;
      hasAny = true;
    }
  }
  return hasAny ? attrs : undefined;
}

function extractCustomLabels(item: FeedItem): string[] | undefined {
  const labels: string[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const val = cleanPlainText(item[`custom_label_${i}`], 80);
    if (val && !labels.includes(val)) labels.push(val);
  }
  return labels.length ? labels : undefined;
}

/** 按 reference/scripts/crawl/gmc_feed.py 生成同字段、同顺序的每日快照，并附带深度可选字段供 catalog/skus 消费。 */
export function toSnapshot(items: readonly FeedItem[], site: FeedSiteConfig, today = localDate(site.timezone)): SnapshotResult {
  const cfg = site.crawl ?? {};
  const skuField = cfg.sku_field ?? "id";
  const seen = new Set<string>();
  const stats: Record<string, number> = {};
  const rows: FeedSnapshot[] = [];
  const groups = new Map<string, { row: FeedSnapshot; item: FeedItem }[]>();
  const count = (key: string) => { stats[key] = (stats[key] ?? 0) + 1; };

  for (const item of items) {
    const sku = String(item[skuField] || item.id || "").trim();
    if (!sku) { count("no_id"); continue; }
    if (seen.has(sku)) { count("duplicate"); continue; }
    const url = cleanUrl(String(item.link || item.mobile_link || ""), site.base_url);
    const [basePrice, baseCurrency] = parsePrice(typeof item.price === "string" ? item.price : undefined);
    const [salePrice, saleCurrency] = parsePrice(typeof item.sale_price === "string" ? item.sale_price : undefined);
    if (basePrice === null || !url) { count("missing_price_or_link"); continue; }
    seen.add(sku);
    let price = basePrice;
    let compareAt: number | null = null;
    if (salePrice !== null && salePrice < basePrice && saleActive(typeof item.sale_price_effective_date === "string" ? item.sale_price_effective_date : undefined, today)) {
      price = salePrice;
      compareAt = basePrice;
    }
    const statusKey = String(item.availability ?? "").trim().toLowerCase();
    const stock = STOCK_MAP[statusKey] ?? "unknown";
    count(stock);
    const [category, categories] = categoryOf(item, cfg, url);
    const qtyText = String(item.quantity || item.sell_on_google_quantity || "");
    const qty = /^\d+$/.test(qtyText) ? Number.parseInt(qtyText, 10) : null;
    const groupId = String(item.item_group_id ?? "");
    const productTypeRaw = cleanPlainText(item.product_type ?? item.google_product_category, 200);
    const description = cleanPlainText(item.description ?? item.short_description, 300);
    const highlights = extractFeedHighlights(item);
    const attributes = extractFeedAttributes(item);
    const customLabels = extractCustomLabels(item);
    const row: FeedSnapshot = {
      sku,
      product_id: groupId || String(item.id ?? ""),
      handle: handleOf(item, url),
      title: String(item.title || sku),
      variant_title: null,
      url,
      category,
      categories,
      ...(productTypeRaw ? { product_type_raw: productTypeRaw } : {}),
      ...(description ? { description } : {}),
      ...(highlights ? { highlights } : {}),
      ...(attributes ? { attributes } : {}),
      ...(customLabels ? { custom_labels: customLabels } : {}),
      price,
      compare_at_price: compareAt,
      currency: baseCurrency ?? saleCurrency ?? site.currency ?? "",
      image_url: cleanUrl(typeof item.image_link === "string" ? item.image_link : undefined),
      stock_status: stock,
      qty,
    };
    rows.push(row);
    if (groupId) {
      const members = groups.get(groupId) ?? [];
      members.push({ row, item });
      groups.set(groupId, members);
    }
  }

  for (const [groupId, members] of groups) {
    if (members.length < 2) continue;
    const handle = [...members].sort((a, b) => a.row.handle.length - b.row.handle.length)[0]!.row.handle;
    const differing = VARIANT_ATTRIBUTES.filter((attribute) => new Set(members.map(({ item }) => String(item[attribute] ?? ""))).size > 1);
    for (const { row, item } of members) {
      row.handle = handle;
      row.product_id = groupId;
      const variant = differing.map((attribute) => item[attribute]).filter((value): value is string => typeof value === "string" && !!value);
      row.variant_title = variant.length ? variant.join(" / ") : null;
    }
  }
  return { rows, stats, filtered: {
    no_id: stats.no_id ?? 0,
    missing_price_or_link: stats.missing_price_or_link ?? 0,
    duplicate: stats.duplicate ?? 0,
  } };
}

/** 快照文件的格式按 gmc_feed.py 的 json.dumps 默认空格输出（仅输出 14 个基准字段以保持快照兼容性）。 */
export async function writeSnapshot(filePath: string, rows: readonly FeedSnapshot[]): Promise<void> {
  const lines = rows.map((row) => {
    const canonical: Record<string, unknown> = {};
    for (const key of SNAPSHOT_CANONICAL_KEYS) canonical[key] = row[key] ?? null;
    return pythonJson(canonical);
  });
  await atomicWrite(filePath, lines.length ? `${lines.join("\n")}\n` : "");
}

function pythonJson(value: unknown): string {
  const serialize = (current: unknown, key?: string): string => {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") {
      const jsonNumber = JSON.stringify(current);
      return (key === "price" || key === "compare_at_price") && Number.isInteger(current) ? `${jsonNumber}.0` : jsonNumber;
    }
    if (typeof current === "boolean") return current ? "true" : "false";
    if (Array.isArray(current)) return `[${current.map((child) => serialize(child)).join(", ")}]`;
    if (typeof current === "object") {
      return `{${Object.entries(current).map(([childKey, child]) => `${JSON.stringify(childKey)}: ${serialize(child, childKey)}`).join(", ")}}`;
    }
    return "null";
  };
  return serialize(value);
}

function isGzip(data: Uint8Array): boolean {
  return data[0] === 0x1f && data[1] === 0x8b;
}

function maybeGunzip(data: Uint8Array): Uint8Array {
  if (!isGzip(data)) return data;
  try { return new Uint8Array(gunzipSync(data)); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FeedError("FEED_FETCH_FAILED", `商品 feed 的 gzip 文件无法解压：${reason}`);
  }
}

function looksLikeHtml(data: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(data.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart();
  return /^(?:<!doctype\s+html\b|<html\b)/i.test(prefix);
}

async function loadSource(source: string, userAgent: string): Promise<Uint8Array> {
  let data: Uint8Array;
  let contentType = "";
  let response: Response | null = null;
  if (/^https?:\/\//i.test(source)) {
    response = await fetch(source, { headers: { "user-agent": userAgent } });
    contentType = response.headers.get("content-type") ?? "";
    data = new Uint8Array(await response.arrayBuffer());
    if (/^text\/html(?:\s*;|$)/i.test(contentType.trim())) throw new FeedError("FEED_FETCH_FAILED", HTML_FEED_MESSAGE);
  } else {
    data = await readFile(path.resolve(source));
  }
  data = maybeGunzip(data);
  if (looksLikeHtml(data)) throw new FeedError("FEED_FETCH_FAILED", HTML_FEED_MESSAGE);
  if (response && !response.ok) throw new FeedError("FEED_FETCH_FAILED", `Feed 返回 HTTP ${response.status}: ${source}`);
  return data;
}

/** 根据 site.json 中的 feed_url 顺序载入多份 feed；同 ID 首条优先由 toSnapshot 处理。 */
export async function readFeeds(site: FeedSiteConfig): Promise<FeedItem[]> {
  const sources = site.crawl?.feed_url;
  if (!sources || sources === "TODO") throw new FeedError("FEED_FETCH_FAILED", "site.json 中尚未配置 crawl.feed_url。");
  const list = typeof sources === "string" ? [sources] : sources;
  const userAgent = site.crawl?.user_agent ?? "SiteOpsBot/1.0";
  const items: FeedItem[] = [];
  for (const source of list) items.push(...parseFeed(await loadSource(source, userAgent)));
  return items;
}
