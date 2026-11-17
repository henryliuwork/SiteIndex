import type { DetectResult, Platform } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SITEMAPS = 32;

interface TextResponse {
  response: Response;
  text: string;
}

function projectError(message: string, detail?: string) {
  return { code: "FEED_FETCH_FAILED" as const, message, ...(detail ? { detail } : {}) };
}

function normalizeInput(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw projectError("请输入网站地址。");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw projectError("网站地址无效。", input);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw projectError("网站地址必须使用 HTTP 或 HTTPS。", input);
  if (url.username || url.password) throw projectError("网站地址不能包含用户名或密码。", input);
  url.hash = "";
  return url;
}

async function fetchText(url: string, userAgent = "SiteIndex/1.0"): Promise<TextResponse> {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/html,application/xml,text/xml,*/*;q=0.5" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { response, text: await response.text() };
}

async function fetchHome(input: URL): Promise<{ result: TextResponse; finalUrl: string; redirectStatus: number | null }> {
  let current = input;
  const visited = new Set<string>();
  let redirectStatus: number | null = null;
  for (let count = 0; count < 6; count += 1) {
    if (visited.has(current.href)) throw projectError("网站重定向形成循环。", current.href);
    visited.add(current.href);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "SiteIndex/1.0", accept: "text/html,*/*;q=0.5" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      redirectStatus ??= response.status;
      const next = new URL(location, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") throw projectError("网站重定向到了不支持的协议。", next.href);
      current = next;
      continue;
    }
    return { result: { response, text: await response.text() }, finalUrl: response.url || current.href, redirectStatus };
  }
  throw projectError("网站重定向次数过多。", input.href);
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function metaValue(html: string, names: readonly string[]): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.name ?? attrs.property ?? attrs.itemprop ?? "").toLowerCase();
    if (names.includes(key) && attrs.content) return attrs.content.trim();
  }
  return null;
}

function sitePlatform(html: string, headers: Headers): { platform: Platform; evidence: string } {
  const source = `${html}\n${headers.get("x-powered-by") ?? ""}\n${headers.get("x-generator") ?? ""}`.toLowerCase();
  const signals: [Platform, RegExp, string][] = [
    ["shopify", /cdn\.shopify\.com|shopify\.(?:theme|routes|analytics)|x-shopify-stage/, "Shopify 页面或响应头标记"],
    ["woocommerce", /woocommerce|wp-content\/plugins\/woocommerce/, "WooCommerce 页面标记"],
    ["wordpress", /wp-content\/|wp-includes\/|wordpress/, "WordPress 页面标记"],
    ["magento", /mage\/cookies|magento|x-magento/, "Magento 页面或响应头标记"],
  ];
  for (const [platform, pattern, evidence] of signals) {
    if (pattern.test(source)) return { platform, evidence };
  }
  return { platform: "other", evidence: "未发现明确的平台标记" };
}

function frontend(html: string): string | null {
  if (/\bShopify\.theme\b|cdn\.shopify\.com/i.test(html)) return "Shopify";
  if (/__NEXT_DATA__|\/_next\//i.test(html)) return "Next.js";
  if (/data-reactroot|react\.production\.min\.js/i.test(html)) return "React";
  if (/data-v-[a-f\d]{6,}|__VUE__/i.test(html)) return "Vue";
  if (/ng-version=/i.test(html)) return "Angular";
  return null;
}

function feedLinks(html: string, baseUrl: string): string[] {
  const values = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    const type = (attrs.type ?? "").toLowerCase();
    const href = attrs.href;
    if (!href || !(rel.includes("alternate") || rel.includes("feed")) || !/(rss|atom|xml)/.test(type)) continue;
    try {
      const url = new URL(href, baseUrl);
      const hint = `${url.pathname} ${url.search} ${attrs.title ?? ""}`;
      const productFeed = /product|catalog|merchant|shopping|\bgmc\b|woocommerce/i.test(hint);
      const articleFeed = /(?:^|\/)(?:comments?|tag|author|blog|news)(?:\/|$)/i.test(url.pathname)
        || /^\/feed\/?$/i.test(url.pathname)
        || /\/feed\/?$/i.test(url.pathname)
        || /(?:^|[?&])feed=(?:rss2?|atom)(?:&|$)/i.test(url.search);
      if ((url.protocol === "http:" || url.protocol === "https:") && productFeed && !articleFeed) values.add(url.href);
    } catch { /* 跳过无效候选地址 */ }
  }
  return [...values].sort(compareKeys);
}

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)]
    .map((match) => match[1]!.replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

type SitemapRole = "product" | "category" | "blog" | "index" | "other";
interface SitemapInspection {
  rows: DetectResult["sitemaps"];
  hints: { url: string; role: SitemapRole }[];
  categoryPrefixCandidates: string[];
}

function sitemapRole(url: string): SitemapRole {
  let name: string;
  try { name = new URL(url).pathname.toLowerCase(); }
  catch { return "other"; }
  if (/product[-_]?cat|categor|taxonomy|collection/.test(name)) return "category";
  if (/product/.test(name)) return "product";
  if (/post|blog|news/.test(name)) return "blog";
  return "other";
}

async function inspectSitemaps(baseUrl: string, robotsText: string): Promise<SitemapInspection> {
  const candidates = new Set<string>();
  for (const match of robotsText.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) candidates.add(match[1]!);
  const fallback = candidates.size === 0;
  if (fallback) for (const name of ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"]) candidates.add(new URL(name, baseUrl).href);

  const results: DetectResult["sitemaps"] = [];
  const hints: SitemapInspection["hints"] = [];
  const prefixes = new Map<string, number>();
  const queue = fallback ? [] : [...candidates].slice(0, MAX_SITEMAPS);
  const inspected = new Set<string>();
  const prefetched = new Map<string, TextResponse>();
  if (fallback) {
    for (const candidate of candidates) {
      try {
        const fetched = await fetchText(candidate);
        if (fetched.response.ok && /<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(fetched.text)) {
          prefetched.set(candidate, fetched);
          queue.push(candidate);
          break;
        }
      } catch { /* 继续尝试下一个常见 sitemap 地址 */ }
    }
  }
  while (queue.length && inspected.size < MAX_SITEMAPS) {
    const url = queue.shift()!;
    if (inspected.has(url)) continue;
    inspected.add(url);
    try {
      const { response, text } = prefetched.get(url) ?? await fetchText(url);
      if (!response.ok || !/<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(text)) continue;
      if (/<(?:\w+:)?sitemapindex\b/i.test(text)) {
        const children = sitemapLocs(text).filter((child) => /^https?:\/\//i.test(child));
        results.push({ url, type: "index", url_count: children.length, role: "index" });
        hints.push({ url, role: "index" });
        const priority = { category: 0, product: 1, blog: 2, index: 3, other: 4 };
        children.sort((a, b) => priority[sitemapRole(a)] - priority[sitemapRole(b)] || compareKeys(a, b));
        for (const child of children) if (!inspected.has(child) && queue.length + inspected.size < MAX_SITEMAPS) queue.push(child);
      } else {
        const role = sitemapRole(url);
        results.push({ url, type: "urlset", url_count: [...text.matchAll(/<(?:\w+:)?url\b/gi)].length, role });
        hints.push({ url, role });
        if (role === "category") for (const location of sitemapLocs(text)) {
          try {
            const page = new URL(location);
            if (page.origin !== baseUrl) continue;
            const segments = decodeURI(page.pathname).split("/").filter(Boolean);
            if (segments.length < 2) continue;
            const prefix = `/${segments.slice(0, -1).join("/")}/{slug}`;
            prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
          } catch { /* 跳过无效分类 URL */ }
        }
      }
    } catch { /* 一张 sitemap 不可用时继续检查其他候选 */ }
  }
  return { rows: results, hints, categoryPrefixCandidates: [...prefixes]
    .sort(([a, countA], [b, countB]) => countB - countA || compareKeys(a, b)).map(([prefix]) => prefix) };
}

/** 识别站点平台、robots、sitemap 与 feed 链接候选。 */
export async function detectSiteDetailed(input: string): Promise<{ result: DetectResult; robotsText: string; sitemapHints: SitemapInspection["hints"]; categoryPrefixCandidates: string[] }> {
  const inputUrl = normalizeInput(input);
  let home: Awaited<ReturnType<typeof fetchHome>>;
  try {
    home = await fetchHome(inputUrl);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw projectError("无法访问网站。", error instanceof Error ? error.message : String(error));
  }

  const finalUrl = new URL(home.finalUrl);
  const origin = finalUrl.origin;
  let robotsText = "";
  let robotsFound = false;
  try {
    const robots = await fetchText(new URL("/robots.txt", origin).href);
    robotsFound = robots.response.ok;
    if (robotsFound) robotsText = robots.text;
  } catch { /* robots.txt 可选 */ }
  const sitemapInspection = await inspectSitemaps(origin, robotsText);
  const sitemapRows = sitemapInspection.rows;
  const platform = sitePlatform(home.result.text, home.result.response.headers);
  const localeRaw = metaValue(home.result.text, ["og:locale"]) ?? /<html\b[^>]*\blang\s*=\s*(["']?)([^\s"'>]+)\1/i.exec(home.result.text)?.[2] ?? null;
  const locale = localeRaw?.replaceAll("_", "-") ?? null;
  const currency = metaValue(home.result.text, ["og:price:currency", "product:price:currency"])
    ?? /"priceCurrency"\s*:\s*"([A-Z]{3})"/i.exec(home.result.text)?.[1]
    ?? null;
  const disallowCount = [...robotsText.matchAll(/^\s*disallow\s*:\s*\S+/gim)].length;
  const sitemapUrls = [...new Set([
    ...[...robotsText.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((match) => match[1]!),
    ...sitemapRows.map((row) => row.url),
  ])];
  const result: DetectResult = {
    input,
    final_url: finalUrl.href,
    redirect_status: home.redirectStatus,
    robots: { found: robotsFound, disallow_count: disallowCount, sitemaps: sitemapUrls },
    sitemaps: sitemapRows,
    category_prefix_candidates: sitemapInspection.categoryPrefixCandidates,
    total_urls: sitemapRows.filter((row) => row.type === "urlset").reduce((total, row) => total + row.url_count, 0),
    platform: platform.platform,
    platform_evidence: platform.evidence,
    frontend: frontend(home.result.text),
    locale,
    currency: currency?.toUpperCase() ?? null,
    feed_candidates: feedLinks(home.result.text, finalUrl.href),
  };
  return { result, robotsText, sitemapHints: sitemapInspection.hints, categoryPrefixCandidates: sitemapInspection.categoryPrefixCandidates };
}

export async function detectSite(input: string): Promise<DetectResult> {
  return (await detectSiteDetailed(input)).result;
}
