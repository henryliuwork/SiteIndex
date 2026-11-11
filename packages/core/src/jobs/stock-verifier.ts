import { parseDocument } from "htmlparser2";
import type { StockStatus } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

export interface StockRules {
  in_stock: string[];
  out_of_stock: string[];
  preorder?: string[];
}

export interface StockVerificationSite {
  base_url?: string;
  crawl?: {
    rate_limit_ms?: number;
    stock_verify?: { enabled: boolean; graphql_url?: string; max_per_run?: number };
    stock_rules?: StockRules;
  };
}

export type MissingStockResult =
  | { kind: "status"; status: StockStatus }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export interface MissingStockBatch {
  results: ReadonlyMap<string, MissingStockResult>;
  checked: number;
  unavailable: number;
  deferred: number;
}

export interface StockVerifierRuntime {
  fetcher?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  startAfterSku?: string;
  beforeCandidate?: (sku: string) => Promise<void>;
}

type HtmlNode = { type: string; name?: string; data?: string; children?: HtmlNode[] };
type JsonObject = Record<string, unknown>;

const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const OMIT_TEXT = new Set(["script", "style", "noscript", "template"]);
const GRAPHQL_QUERY = "query SiteIndexStockBySku($sku: String!) { products(filter: { sku: { eq: $sku } }) { items { sku stock_status } } }";

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedHttpOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url;
    const host = url.hostname.toLowerCase();
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(host) ? url : null;
  } catch {
    return null;
  }
}

function sameOriginUrl(value: string, base: URL): URL | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function graphqlUrl(configured: string | undefined, base: URL): URL | null {
  try {
    const target = new URL(configured?.trim() || "/graphql", base);
    return allowedHttpOrigin(target.toString());
  } catch {
    return null;
  }
}

function statusFromValue(value: unknown): StockStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toUpperCase()) {
    case "IN_STOCK":
    case "IN STOCK":
      return "in_stock";
    case "OUT_OF_STOCK":
    case "OUT OF STOCK":
      return "out_of_stock";
    case "PREORDER":
    case "PRE-ORDER":
      return "preorder";
    case "UNKNOWN":
      return "unknown";
    default:
      return undefined;
  }
}

function graphqlStatus(payload: unknown, expectedSku: string): StockStatus | undefined {
  if (!isRecord(payload)) return undefined;
  if ("errors" in payload && (!Array.isArray(payload.errors) || payload.errors.length > 0)) return undefined;
  if (!isRecord(payload.data)) return undefined;
  const data = payload.data;
  const direct = isRecord(data.product) && data.product.sku === expectedSku
    ? statusFromValue(data.product.stock_status)
    : undefined;
  if (direct) return direct;
  if (!isRecord(data.products) || !Array.isArray(data.products.items)) return undefined;
  const product = data.products.items.find((item) => isRecord(item) && item.sku === expectedSku);
  return product ? statusFromValue(product.stock_status) : undefined;
}

function textOf(node: HtmlNode): string {
  if (node.type === "text") return node.data ?? "";
  if (node.name && OMIT_TEXT.has(node.name.toLowerCase())) return "";
  return (node.children ?? []).map(textOf).join(" ");
}

function pageTextStatus(html: string, rules: StockRules | undefined): StockStatus | undefined {
  if (!rules) return undefined;
  const root = parseDocument(html) as unknown as HtmlNode;
  const text = textOf(root).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  const matches: StockStatus[] = [];
  const phrases = (value: unknown): readonly string[] => Array.isArray(value)
    ? value.filter((phrase): phrase is string => typeof phrase === "string")
    : [];
  const candidates: [StockStatus, readonly string[]][] = [
    ["in_stock", phrases(rules.in_stock)],
    ["out_of_stock", phrases(rules.out_of_stock)],
    ["preorder", phrases(rules.preorder)],
  ];
  for (const [status, phrases] of candidates) {
    if (phrases.some((phrase) => {
      const normalized = phrase.trim().normalize("NFKC").toLowerCase();
      return normalized && text.includes(normalized);
    })) matches.push(status);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function responseStatus(response: Response): "ok" | "not_found" | "unavailable" {
  if (response.status === 404 || response.status === 410) return "not_found";
  return response.status >= 200 && response.status < 300 ? "ok" : "unavailable";
}

/** 核验 feed 缺席的 SKU。按 SKU 确定性轮转、串行限速；结果不包含 URL 或响应正文。 */
export async function verifyMissingStock(
  candidates: readonly { sku: string; url: string }[],
  site: StockVerificationSite,
  runtime: StockVerifierRuntime = {},
): Promise<MissingStockBatch> {
  const config = site.crawl?.stock_verify;
  if (!config?.enabled || !site.base_url) return { results: new Map(), checked: 0, unavailable: 0, deferred: candidates.length };
  const base = allowedHttpOrigin(site.base_url);
  if (!base) return { results: new Map(), checked: 0, unavailable: candidates.length, deferred: 0 };
  const graphql = graphqlUrl(config.graphql_url, base);
  if (!graphql) return { results: new Map(), checked: 0, unavailable: candidates.length, deferred: 0 };

  const limit = Math.max(0, Math.floor(config.max_per_run ?? DEFAULT_MAX_PER_RUN));
  const ordered = [...candidates].sort((a, b) => compareKeys(a.sku, b.sku));
  const cursor = runtime.startAfterSku;
  const startIndex = cursor === undefined
    ? 0
    : ordered.findIndex(({ sku }) => compareKeys(sku, cursor) > 0);
  const rotated = startIndex > 0 ? [...ordered.slice(startIndex), ...ordered.slice(0, startIndex)] : ordered;
  const pending = rotated.slice(0, limit);
  const rateLimitMs = Math.max(0, Number(site.crawl?.rate_limit_ms ?? 1500));
  const timeoutMs = Math.max(1, runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetcher = runtime.fetcher ?? fetch;
  const wait = runtime.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let nextAllowedAt = 0;
  const request = async (url: URL, init: RequestInit): Promise<Response> => {
    const delay = Math.max(0, nextAllowedAt - Date.now());
    if (delay) await wait(delay);
    try {
      return await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    } finally {
      nextAllowedAt = Date.now() + rateLimitMs;
    }
  };

  const results = new Map<string, MissingStockResult>();
  let checked = 0;
  let unavailable = 0;
  let processed = 0;
  for (const candidate of pending) {
    try {
      await runtime.beforeCandidate?.(candidate.sku);
    } catch {
      results.set(candidate.sku, { kind: "unavailable" });
      unavailable += 1;
      processed += 1;
      break;
    }
    processed += 1;
    checked += 1;
    const productUrl = sameOriginUrl(candidate.url, base);
    if (!productUrl) {
      results.set(candidate.sku, { kind: "unavailable" });
      unavailable += 1;
      continue;
    }

    let page: Response;
    try {
      page = await request(productUrl, { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } });
    } catch {
      results.set(candidate.sku, { kind: "unavailable" });
      unavailable += 1;
      continue;
    }
    const pageOutcome = responseStatus(page);
    if (pageOutcome === "not_found") {
      results.set(candidate.sku, { kind: "not_found" });
      continue;
    }
    if (pageOutcome !== "ok") {
      results.set(candidate.sku, { kind: "unavailable" });
      unavailable += 1;
      continue;
    }

    let html: string;
    try {
      html = await page.text();
    } catch {
      results.set(candidate.sku, { kind: "unavailable" });
      unavailable += 1;
      continue;
    }

    let graphqlBusinessUnknown = false;
    try {
      const response = await request(graphql, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { sku: candidate.sku } }),
      });
      if (responseStatus(response) === "ok") {
        const status = graphqlStatus(await response.json().catch(() => null), candidate.sku);
        if (status && status !== "unknown") {
          results.set(candidate.sku, { kind: "status", status });
          continue;
        }
        graphqlBusinessUnknown = status === "unknown";
      }
    } catch {
      // The page-text fallback is still useful when the optional GraphQL endpoint is unavailable.
    }

    const status = pageTextStatus(html, site.crawl?.stock_rules);
    if (status) results.set(candidate.sku, { kind: "status", status });
    else if (graphqlBusinessUnknown) results.set(candidate.sku, { kind: "status", status: "unknown" });
    else {
      results.set(candidate.sku, { kind: "unavailable" });
      unavailable += 1;
    }
  }

  return { results, checked, unavailable, deferred: ordered.length - processed };
}
