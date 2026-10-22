import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { EXIT, type SiteIndexErrorCode, type StockStatus } from "@siteindex/shared";
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

interface XmlNode {
  name: string;
  localName: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return whole; }
  });
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return name.slice(colon + 1).toLowerCase();
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attrPattern)) attrs[match[1]!] = decodeXml(match[2] ?? match[3] ?? "");
  return attrs;
}

function parseXmlItems(source: string): FeedItem[] {
  const items: FeedItem[] = [];
  const stack: XmlNode[] = [];
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) {
      if (token.startsWith("<![CDATA[")) stack.at(-1)!.text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      const closing = /^<\/\s*([^\s>]+)\s*>$/.exec(token)?.[1];
      const node = stack.pop();
      if (!node || node.name !== closing) throw new FeedError("FEED_FETCH_FAILED", "Feed XML 标签不匹配。");
      if (node.localName === "item" || node.localName === "entry") {
        const row: FeedItem = {};
        for (const child of node.children) {
          if (child.children.length) continue;
          let value = child.text.trim();
          if (child.localName === "link" && !value) value = child.attrs.href ?? "";
          if ((child.localName === "additional_image_link" || child.localName === "product_type") && Object.hasOwn(row, child.localName)) {
            const allKey = `${child.localName}_all`;
            if (!Array.isArray(row[allKey])) row[allKey] = [String(row[child.localName] ?? "")];
            (row[allKey] as string[]).push(value);
          } else if (!Object.hasOwn(row, child.localName)) row[child.localName] = value;
        }
        items.push(row);
      }
      stack.at(-1)?.children.push(node);
      continue;
    }
    if (token.startsWith("<")) {
      const name = /^<\s*([^\s/>]+)/.exec(token)?.[1];
      if (!name) continue;
      const attrText = token.slice(name.length + 1, token.length - (token.endsWith("/> ") ? 3 : 1));
      const selfClosing = /\/\s*>$/.test(token);
      const node: XmlNode = { name, localName: localName(name), attrs: parseAttributes(attrText), text: "", children: [] };
      if (selfClosing) {
        stack.at(-1)?.children.push(node);
      } else stack.push(node);
      continue;
    }
    if (stack.length) stack.at(-1)!.text += decodeXml(token);
  }
  if (stack.length) throw new FeedError("FEED_FETCH_FAILED", "Feed XML 未闭合。");
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
  const source = typeof data === "string" ? data : new TextDecoder().decode(data);
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
}

/** 按 SKU 合并 site.json 的覆盖字段；daily 在写入主表前调用，快照原始文件保持 feed 原样。 */
export function applyFeedOverrides(
  rows: readonly FeedSnapshot[],
  overrides: Record<string, Record<string, unknown>> = {},
): FeedSnapshot[] {
  return rows.map((row) => ({ ...row, ...overrides[row.sku] }) as FeedSnapshot);
}

/** 按 reference/scripts/crawl/gmc_feed.py 生成同字段、同顺序的每日快照。 */
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
    seen.add(sku);
    const url = cleanUrl(String(item.link || item.mobile_link || ""), site.base_url);
    const [basePrice, baseCurrency] = parsePrice(typeof item.price === "string" ? item.price : undefined);
    const [salePrice, saleCurrency] = parsePrice(typeof item.sale_price === "string" ? item.sale_price : undefined);
    if (basePrice === null || !url) { count("missing_price_or_link"); continue; }
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
    const row: FeedSnapshot = {
      sku,
      product_id: groupId || String(item.id ?? ""),
      handle: handleOf(item, url),
      title: String(item.title || sku),
      variant_title: null,
      url,
      category,
      categories,
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
  return { rows, stats };
}

/** 快照文件的格式按 gmc_feed.py 的 json.dumps 默认空格输出。 */
export async function writeSnapshot(filePath: string, rows: readonly FeedSnapshot[]): Promise<void> {
  const lines = rows.map((row) => pythonJson(row));
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

async function loadSource(source: string, userAgent: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { "user-agent": userAgent } });
    if (!response.ok) throw new FeedError("FEED_FETCH_FAILED", `Feed 返回 HTTP ${response.status}: ${source}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const data = await readFile(path.resolve(source));
  return data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data;
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
