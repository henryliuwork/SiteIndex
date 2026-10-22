import type { DetectResult, Platform } from "@siteindex/shared";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SITEMAPS = 12;

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
      if (url.protocol === "http:" || url.protocol === "https:") values.add(url.href);
    } catch { /* 跳过无效候选地址 */ }
  }
  return [...values].sort();
}

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)]
    .map((match) => match[1]!.replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

async function inspectSitemaps(baseUrl: string, robotsText: string): Promise<DetectResult["sitemaps"]> {
  const candidates = new Set<string>();
  for (const match of robotsText.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) candidates.add(match[1]!);
  if (candidates.size === 0) candidates.add(new URL("/sitemap.xml", baseUrl).href);

  const results: DetectResult["sitemaps"] = [];
  const queue = [...candidates].slice(0, MAX_SITEMAPS);
  const inspected = new Set<string>();
  while (queue.length && inspected.size < MAX_SITEMAPS) {
    const url = queue.shift()!;
    if (inspected.has(url)) continue;
    inspected.add(url);
    try {
      const { response, text } = await fetchText(url);
      if (!response.ok || !/<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(text)) continue;
      if (/<(?:\w+:)?sitemapindex\b/i.test(text)) {
        const children = sitemapLocs(text).filter((child) => /^https?:\/\//i.test(child));
        results.push({ url, type: "index", url_count: children.length });
        for (const child of children) if (!inspected.has(child) && queue.length + inspected.size < MAX_SITEMAPS) queue.push(child);
      } else {
        results.push({ url, type: "urlset", url_count: [...text.matchAll(/<(?:\w+:)?url\b/gi)].length });
      }
    } catch { /* 一张 sitemap 不可用时继续检查其他候选 */ }
  }
  return results;
}

/** 识别站点平台、robots、sitemap 与 feed 链接候选。 */
export async function detectSite(input: string): Promise<DetectResult> {
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
  const sitemapRows = await inspectSitemaps(origin, robotsText);
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
  return {
    input,
    final_url: finalUrl.href,
    redirect_status: home.redirectStatus,
    robots: { found: robotsFound, disallow_count: disallowCount, sitemaps: sitemapUrls },
    sitemaps: sitemapRows,
    total_urls: sitemapRows.filter((row) => row.type === "urlset").reduce((total, row) => total + row.url_count, 0),
    platform: platform.platform,
    platform_evidence: platform.evidence,
    frontend: frontend(home.result.text),
    locale,
    currency: currency?.toUpperCase() ?? null,
    feed_candidates: feedLinks(home.result.text, finalUrl.href),
  };
}
