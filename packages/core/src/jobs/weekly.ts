import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { DEFAULT_DESCRIPTION_RANGE, DEFAULT_TITLE_RANGE, PATHS, gradeDescriptionLength, gradeTitleLength, type BlogPost, type Category, type ProductDetails, type SeoIssue, type SeoLink, type SeoPage, type SeoRule, type SiteConfig } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";
import { readJsonl, writeJsonl } from "../io/jsonl";

type HtmlNode = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: HtmlNode[] };
type JsonObject = Record<string, unknown>;
export type WeeklyStep = "pages" | "issues" | "links" | "blog" | "product_details" | "categories";
export interface WeeklyOptions { date?: string; only?: string; onProgress?: (step: WeeklyStep, message: string) => void }
export interface WeeklyResult { status: "ok" | "partial" | "failed"; counts: Record<string, number>; errors: string[] }

const TRACKING = /^(utm_|gclid$|gbraid$|wbraid$|srsltid$|fbclid$|mc_|_ga$)/i;
const XML = new XMLParser({ ignoreAttributes: true, trimValues: true, processEntities: true });
const OMIT = new Set(["header", "nav", "footer", "aside", "script", "style", "noscript", "template", "svg"]);
const STEPS: readonly WeeklyStep[] = ["pages", "issues", "links", "blog", "product_details", "categories"];

function cleanUrl(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value.trim(), base) : new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const pairs = [...url.searchParams.entries()].filter(([key, val]) => val && !TRACKING.test(key));
    url.search = "";
    for (const [key, val] of pairs) url.searchParams.append(key, val);
    url.hash = "";
    return url.toString();
  } catch { return null; }
}
function asList(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
function asObjects(value: unknown): JsonObject[] { return asList(value).filter((x): x is JsonObject => !!x && typeof x === "object" && !Array.isArray(x)); }
function locs(tree: unknown, entry: "url" | "sitemap"): { loc: string; lastmod?: string }[] {
  const found: { loc: string; lastmod?: string }[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value as JsonObject)) {
      if (key.toLowerCase() === entry) {
        for (const row of asObjects(child)) {
          if (typeof row.loc === "string") found.push({ loc: row.loc, ...(typeof row.lastmod === "string" ? { lastmod: row.lastmod.slice(0, 10) } : {}) });
        }
      } else visit(child);
    }
  };
  visit(tree);
  return found;
}
function walk(root: HtmlNode, predicate: (node: HtmlNode) => boolean, skip: ReadonlySet<string> = new Set()): HtmlNode[] {
  const output: HtmlNode[] = [];
  const visit = (node: HtmlNode) => {
    if (predicate(node)) output.push(node);
    if (node.name && skip.has(node.name.toLowerCase())) return;
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return output;
}
function text(node: HtmlNode, skip: ReadonlySet<string> = OMIT): string {
  if (node.type === "text") return node.data ?? "";
  if (node.name && skip.has(node.name.toLowerCase())) return "";
  return (node.children ?? []).map((child) => text(child, skip)).join(" ").replace(/\s+/g, " ").trim();
}
function attr(node: HtmlNode | undefined, key: string): string | null { return node?.attribs?.[key.toLowerCase()]?.trim() || null; }
function meta(root: HtmlNode, key: string): string | null {
  const lowered = key.toLowerCase();
  return walk(root, (n) => n.name === "meta" && (attr(n, "name")?.toLowerCase() === lowered || attr(n, "property")?.toLowerCase() === lowered))
    .map((n) => attr(n, "content")).find((value): value is string => !!value) ?? null;
}
function area(root: HtmlNode): HtmlNode { return walk(root, (n) => n.name === "main" || n.name === "article")[0] ?? root; }
function contentLinks(root: HtmlNode, pageUrl: string, origin: string): { url: string; anchor: string; nofollow: boolean }[] {
  const links = walk(area(root), (n) => n.name === "a", OMIT);
  return links.flatMap((n) => {
    const href = attr(n, "href");
    const url = href ? cleanUrl(href, pageUrl) : null;
    if (!url || new URL(url).origin !== origin) return [];
    return [{ url, anchor: text(n), nofollow: (attr(n, "rel") ?? "").toLowerCase().split(/\s+/).includes("nofollow") }];
  });
}
function hreflangData(root: HtmlNode, baseUrl: string): { links: { lang: string; url: string }[]; problems: string[] } {
  const links: { lang: string; url: string }[] = [];
  const problems = new Set<string>();
  const seenLanguages = new Set<string>();
  const alternates = walk(root, (node) => node.name === "link"
    && (attr(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")
    && attr(node, "hreflang") !== null, OMIT);
  for (const node of alternates) {
    const language = attr(node, "hreflang");
    if (!language) continue;
    let normalizedLanguage = language.toLowerCase();
    if (normalizedLanguage !== "x-default") {
      try {
        const canonical = Intl.getCanonicalLocales(language);
        if (canonical.length !== 1) throw new RangeError("Expected one language tag");
        normalizedLanguage = canonical[0]!.toLowerCase();
      } catch {
        problems.add("Invalid hreflang language: " + language);
      }
    }
    if (seenLanguages.has(normalizedLanguage)) problems.add("Duplicate hreflang language: " + language);
    seenLanguages.add(normalizedLanguage);
    const targetValue = attr(node, "href");
    const target = targetValue ? cleanUrl(targetValue, baseUrl) : null;
    if (!target) problems.add("Missing or invalid hreflang URL for " + language);
    else links.push({ lang: language, url: target });
  }
  return { links, problems: [...problems].sort(compareKeys) };
}

function jsonLd(root: HtmlNode): JsonObject[] {
  const output: JsonObject[] = [];
  for (const node of walk(root, (n) => n.name === "script" && attr(n, "type")?.toLowerCase() === "application/ld+json")) {
    try {
      const add = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(add); return; }
        if (!value || typeof value !== "object") return;
        output.push(value as JsonObject);
        add((value as JsonObject)["@graph"]);
      };
      add(JSON.parse(text(node, new Set())));
    } catch { /* malformed JSON-LD does not stop the rest of the crawl */ }
  }
  return output;
}
function typesOf(items: JsonObject[]): string[] {
  return [...new Set(items.flatMap((item) => asList(item["@type"]).filter((x): x is string => typeof x === "string")))].sort(compareKeys);
}
function isoDay(value: string | undefined, fallback: string): string {
  const day = value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return day && !Number.isNaN(Date.parse(day + "T00:00:00Z")) ? day : fallback;
}
function finiteNumber(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function pattern(url: string, patterns: string[] = []): boolean {
  return patterns.some((value) => { try { return new RegExp(value, "i").test(url); } catch { return false; } });
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesBlogUrlPattern(url: string, patterns: readonly string[]): boolean {
  return patterns.some((value) => {
    const configured = value.trim();
    if (!configured) return false;
    let candidate = url;
    let prefix = configured;
    if (configured.startsWith("/")) {
      try { candidate = new URL(url).pathname; } catch { return false; }
    } else {
      prefix = cleanUrl(configured) ?? configured;
    }
    if (!prefix.includes("*")) {
      const normalizedPrefix = prefix.replace(/\/$/, "");
      return candidate.toLowerCase() === normalizedPrefix.toLowerCase()
        || candidate.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "/");
    }
    const expression = prefix.split("*").map(escapeRegExp).join(".*");
    try { return new RegExp("^" + expression + "$", "i").test(candidate); } catch { return false; }
  });
}
interface BlogRecognition {
  sitemapUrls: ReadonlySet<string>;
  urlPatterns: readonly string[];
  legacyUrlPatterns: readonly string[];
}
function isConfiguredBlogUrl(url: string, recognition: BlogRecognition): boolean {
  const clean = cleanUrl(url) ?? url;
  return recognition.sitemapUrls.has(clean)
    || matchesBlogUrlPattern(clean, recognition.urlPatterns)
    || pattern(clean, [...recognition.legacyUrlPatterns]);
}
function dateDiff(newer: string, older: string): number { return Math.floor((Date.parse(newer + "T00:00:00Z") - Date.parse(older + "T00:00:00Z")) / 86400000); }

interface Parsed { page: SeoPage; doc: HtmlNode; links: { url: string; anchor: string; nofollow: boolean }[]; hreflangProblems: string[]; lastmod?: string }
interface FetchData { status: number; body: string; url: string; redirects: string[]; ms: number; xRobotsTag: string | null }

function schemaTypeName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().split(/[\/#:]/).filter(Boolean).at(-1) ?? "" : "";
}
function hasSchemaType(item: JsonObject, expected: string): boolean {
  return asList(item["@type"]).some((value) => schemaTypeName(value) === expected.toLowerCase());
}
function hasAnySchemaType(items: JsonObject[], expected: readonly string[]): boolean {
  return items.some((item) => expected.some((type) => hasSchemaType(item, type)));
}
function classTokens(node: HtmlNode): string[] { return (attr(node, "class") ?? "").toLowerCase().split(/\s+/).filter(Boolean); }
function hasClass(root: HtmlNode, expected: RegExp): boolean {
  return walk(root, (node) => classTokens(node).some((token) => expected.test(token)), OMIT).length > 0;
}
function hasProductDocument(root: HtmlNode): boolean {
  const ld = jsonLd(root).filter((item) => hasSchemaType(item, "product"));
  const headings = [...walk(root, (node) => node.name === "h1" || node.name === "title", OMIT).map((node) => text(node).toLowerCase().trim())];
  const schemaNamesMatch = ld.some((item) => typeof item.name === "string" && headings.includes(item.name.toLowerCase().trim()));
  const productMain = hasClass(root, /^(product-info-main|product-view)$/);
  const productMedia = hasClass(root, /^(gallery-placeholder|fotorama|product-gallery)$/)
    || walk(root, (node) => classTokens(node).includes("product") && classTokens(node).includes("media"), OMIT).length > 0;
  const productPrice = hasClass(root, /^(price-box|product-info-price)$/)
    || walk(root, (node) => !!attr(node, "data-role")?.toLowerCase().includes("pricebox"), OMIT).length > 0;
  const productItem = walk(root, (node) => schemaTypeName(attr(node, "itemtype")) === "product", OMIT)
    .some((node) => walk(node, (child) => child.name === "h1", OMIT).length > 0);
  return (productMain && walk(root, (node) => node.name === "h1", OMIT).length > 0)
    || (productMedia && productPrice && walk(root, (node) => node.name === "h1", OMIT).length > 0)
    || schemaNamesMatch || productItem;
}
function hasBlogDocument(root: HtmlNode): boolean {
  const articles = jsonLd(root).filter((item) => ["article", "blogposting", "newsarticle"].some((type) => hasSchemaType(item, type)));
  const headings = [...walk(root, (node) => node.name === "h1" || node.name === "title", OMIT).map((node) => text(node).toLowerCase().trim())];
  if (articles.some((item) => typeof item.headline === "string" && headings.includes(item.headline.toLowerCase().trim()))) return true;
  const hasPostClass = hasClass(root, /^(amblog-post|post-view|blog-post|post-content)$/);
  if (hasPostClass && walk(root, (node) => node.name === "h1", OMIT).length > 0) return true;
  return walk(root, (node) => node.name === "article", OMIT).length > 0
    && (meta(root, "article:published_time") !== null || articles.length > 0);
}
function isBlogPostPath(pathname: string): boolean {
  if (/\/\d{4}\/\d{2}\//.test(pathname)) return true;
  const segments = pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const rootIndex = segments.findIndex((segment) => /^(blogs?|news)$/.test(segment.replace(/\.html?$/, "")));
  if (rootIndex < 0) return false;
  const slug = segments[rootIndex + 1]?.replace(/\.html?$/, "");
  return !!slug && !["category", "categories", "tag", "tags", "author", "page", "archive"].includes(slug);
}
function urlSlug(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.(?:html?|php)$/i, "") ?? "";
}
function pageType(url: string, productUrls: ReadonlySet<string> = new Set(), categoryPattern?: string, categorySlugs: ReadonlySet<string> = new Set(), doc?: HtmlNode, blog: BlogRecognition = { sitemapUrls: new Set(), urlPatterns: [], legacyUrlPatterns: [] }): SeoPage["page_type"] {
  const pathname = new URL(url).pathname;
  const clean = cleanUrl(url);
  if (clean && productUrls.has(clean)) return "product";
  if (doc && hasProductDocument(doc)) return "product";
  if (pathname === "/") return "home";
  if (/\/products?\//i.test(pathname)) return "product";
  const leaf = pathname.split("/").filter(Boolean).at(-1)?.replace(/\.(?:html?|php)$/i, "").toLowerCase() ?? "";
  if (/\/collections?\//i.test(pathname) || /collection|category|catalog/i.test(pathname) || categorySlugs.has(leaf) || (categoryPattern ? pattern(url, categoryPattern.split(/\s*,\s*/)) : false)) return "collection";
  if (isConfiguredBlogUrl(url, blog) || (doc && hasBlogDocument(doc)) || isBlogPostPath(pathname)) return "blog";
  if (/\/pages?\//i.test(pathname) || pathname.split("/").filter(Boolean).length === 1) return "page";
  return "other";
}

async function crawl(config: SiteConfig, date: string, productUrls: ReadonlySet<string>, categorySlugs: ReadonlySet<string>): Promise<{ rows: Parsed[]; errors: string[]; attempts: number; blogUrls: Set<string> }> {
  const urls = new Map<string, string>();
  const blogUrls = new Set<string>();
  const seen = new Set<string>();
  const seenBlog = new Set<string>();
  const errors: string[] = [];
  let nextAt = 0;
  let attempts = 0;
  const delay = Math.max(0, Number(config.crawl.rate_limit_ms ?? 1500));
  const wait = async () => {
    const remaining = nextAt - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    nextAt = Date.now() + delay;
  };
  const request = async (input: string): Promise<FetchData> => {
    const started = Date.now();
    const redirects: string[] = [];
    let target = input;
    let response: Response | undefined;
    for (let hop = 0; hop <= 10; hop++) {
      for (let retry = 0; retry <= 2; retry++) {
        await wait();
        attempts += 1;
        try {
          response = await fetch(target, { headers: { "user-agent": config.crawl.user_agent ?? "SiteOpsBot/1.0" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
        } catch (error) {
          if (retry === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** retry)));
          continue;
        }
        if (response.status >= 500 && retry < 2) {
          await response.body?.cancel().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** retry)));
          continue;
        }
        break;
      }
      if (!response) throw new Error("fetch returned no response");
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) break;
      redirects.push(target);
      const next = cleanUrl(location, target);
      if (!next) throw new Error("invalid redirect location " + location);
      target = next;
    }
    if (!response) throw new Error("fetch returned no response");
    return { status: response.status, body: await response.text(), url: target, redirects, ms: Date.now() - started, xRobotsTag: response.headers.get("x-robots-tag") };
  };
  const sitemap = async (input: string, depth = 0, isBlogSitemap = false): Promise<void> => {
    const url = cleanUrl(input);
    const visited = isBlogSitemap ? seenBlog : seen;
    if (!url || visited.has(url) || depth > 5) return;
    visited.add(url);
    try {
      const result = await request(url);
      if (result.status < 200 || result.status >= 400) throw new Error("HTTP " + result.status);
      const tree = XML.parse(result.body);
      const nested = locs(tree, "sitemap");
      if (nested.length) for (const row of nested) await sitemap(row.loc, depth + 1, isBlogSitemap);
      else for (const row of locs(tree, "url")) {
        const page = cleanUrl(row.loc);
        if (page && !pattern(page, config.crawl.exclude_url_patterns)) {
          urls.set(page, row.lastmod ?? urls.get(page) ?? "");
          if (isBlogSitemap) blogUrls.add(page);
        }
      }
    } catch (error) { errors.push(url + ": " + (error instanceof Error ? error.message : String(error))); }
  };
  const blog = {
    sitemapUrls: blogUrls,
    urlPatterns: config.content?.blog_url_patterns ?? [],
    legacyUrlPatterns: config.crawl.blog_url_patterns ?? [],
  };
  for (const url of config.content?.blog_sitemaps ?? []) await sitemap(url, 0, true);
  for (const url of config.sitemaps ?? []) await sitemap(url);
  const maximum = Math.max(1, Number(config.crawl.max_pages ?? 2000));
  const origin = new URL(config.base_url).origin;
  const rows: Parsed[] = [];
  for (const [url, lastmod] of [...urls.entries()].slice(0, maximum)) {
    try {
      const response = await request(url);
      const doc = parseDocument(response.body) as unknown as HtmlNode;
      const content = text(area(doc));
      const headings = walk(doc, (n) => n.name === "h1").map((n) => text(n)).filter(Boolean);
      const title = walk(doc, (n) => n.name === "title").map((n) => text(n))[0] || null;
      const description = meta(doc, "description");
      const canonicalNode = walk(doc, (n) => n.name === "link" && (attr(n, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))[0];
      const canonicalHref = attr(canonicalNode, "href");
      const canonical = canonicalHref ? cleanUrl(canonicalHref, response.url) : null;
      const robots = meta(doc, "robots");
      const ld = jsonLd(doc);
      const types = typesOf(ld);
      const schemaErrors: string[] = [];
      for (const item of ld) {
        if (hasSchemaType(item, "product") && !item.name) schemaErrors.push("Product.name missing");
        if ((hasSchemaType(item, "article") || hasSchemaType(item, "blogposting")) && !item.headline) schemaErrors.push("Article.headline missing");
        if (hasSchemaType(item, "breadcrumblist") && !item.itemListElement) schemaErrors.push("BreadcrumbList.itemListElement missing");
      }
      const images = walk(area(doc), (n) => n.name === "img", OMIT);
      const links = contentLinks(doc, response.url, origin);
      const hreflang = hreflangData(doc, response.url);
      const page: SeoPage = {
        url, page_type: pageType(url, productUrls, config.categories.url_pattern, categorySlugs, doc, blog), status_code: response.status, ...(response.url !== url ? { final_url: response.url } : {}),
        ...(response.redirects.length ? { redirect_chain: response.redirects } : {}), response_ms: response.ms,
        title, title_length: title ? [...title].length : 0, meta_description: description, description_length: description ? [...description].length : 0,
        meta_keywords: meta(doc, "keywords"), h1: headings[0] ?? null, h1_count: headings.length,
        h2: walk(doc, (n) => n.name === "h2").map((n) => text(n)).filter(Boolean),
        canonical, canonical_status: !canonical ? "missing" : canonical === url ? "self" : "other",
        robots_meta: robots, x_robots_tag: response.xRobotsTag,
        indexable: response.status < 400 && !/noindex/i.test((robots ?? "") + " " + (response.xRobotsTag ?? "")) && (!canonical || canonical === url),
        in_sitemap: true, hreflang: hreflang.links,
        og: { ...(meta(doc, "og:title") ? { title: meta(doc, "og:title") } : {}), ...(meta(doc, "og:description") ? { description: meta(doc, "og:description") } : {}),
          ...(cleanUrl(meta(doc, "og:image") ?? "", response.url) ? { image: cleanUrl(meta(doc, "og:image")!, response.url) } : {}) },
        twitter_card: meta(doc, "twitter:card"), schema_types: types, ...(schemaErrors.length ? { schema_errors: schemaErrors } : {}),
        word_count: content ? content.split(/\s+/u).filter(Boolean).length : 0,
        images_total: images.length, images_missing_alt: images.filter((n) => !attr(n, "alt")).length,
        links_internal_out: links.length, links_external_out: walk(area(doc), (n) => n.name === "a" && !!attr(n, "href"), OMIT)
          .map((n) => cleanUrl(attr(n, "href")!, response.url)).filter((href) => !!href && new URL(href).origin !== origin).length,
        links_internal_in: 0, last_crawled: date,
      };
      rows.push({ page, doc, links, hreflangProblems: hreflang.problems, ...(lastmod ? { lastmod } : {}) });
    } catch (error) { errors.push(url + ": " + (error instanceof Error ? error.message : String(error))); }
  }
  if (!urls.size) errors.push("sitemap has no crawlable URLs");
  return { rows, errors, attempts, blogUrls };
}

function makeIssues(rows: Parsed[], oldIssues: SeoIssue[], config: SiteConfig, date: string): SeoIssue[] {
  const issues = new Map<string, Omit<SeoIssue, "status" | "first_seen" | "last_seen">>();
  const add = (url: string, rule: SeoRule, severity: SeoIssue["severity"], detail: string) => issues.set(url + "\n" + rule, { url, rule, severity, detail });
  const titleMap = new Map<string, SeoPage[]>(), descMap = new Map<string, SeoPage[]>();
  const titleRange = config.seo?.title_range ?? DEFAULT_TITLE_RANGE;
  const descriptionRange = config.seo?.description_range ?? DEFAULT_DESCRIPTION_RANGE;
  for (const row of rows) {
    const { page } = row;
    if (page.title) titleMap.set(page.title.toLowerCase(), [...(titleMap.get(page.title.toLowerCase()) ?? []), page]);
    if (page.meta_description) descMap.set(page.meta_description.toLowerCase(), [...(descMap.get(page.meta_description.toLowerCase()) ?? []), page]);
    if (page.status_code >= 400 && page.status_code < 500) add(page.url, "http_4xx", "high", "HTTP " + page.status_code);
    if (page.status_code >= 500) add(page.url, "http_5xx", "high", "HTTP " + page.status_code);
    if ((page.redirect_chain?.length ?? 0) >= 2) add(page.url, "redirect_chain", "mid", "Redirect chain has at least two hops");
    if (/noindex/i.test((page.robots_meta ?? "") + " " + (page.x_robots_tag ?? ""))) add(page.url, "noindex", "low", "Page is marked noindex");
    if (page.url.length > 2048) add(page.url, "url_too_long", "low", "URL length " + page.url.length + " exceeds 2048 characters");
    if (row.hreflangProblems.length) add(page.url, "hreflang_invalid", "mid", row.hreflangProblems.join("; "));
    if (page.canonical_status === "other") add(page.url, "canonical_other", "mid", "Canonical points to " + page.canonical);
    if (page.canonical_status === "missing") add(page.url, "canonical_missing", "low", "Canonical link is missing");
    if (!page.title) add(page.url, "title_missing", "mid", "Title is missing");
    else if (gradeTitleLength(page.title_length, titleRange) === "poor") {
      const tooShort = page.title_length < titleRange[0];
      const rule = tooShort ? "title_too_short" : "title_too_long";
      const limit = tooShort ? titleRange[0] : titleRange[1];
      add(page.url, rule, "low", "Title length " + page.title_length + (tooShort ? " is below " : " is above ") + limit);
    }
    if (!page.meta_description) add(page.url, "desc_missing", "mid", "Meta description is missing");
    else if (gradeDescriptionLength(page.description_length, descriptionRange) === "poor") {
      const tooShort = page.description_length < descriptionRange[0];
      const rule = tooShort ? "desc_too_short" : "desc_too_long";
      const limit = tooShort ? descriptionRange[0] : descriptionRange[1];
      add(page.url, rule, "low", "Description length " + page.description_length + (tooShort ? " is below " : " is above ") + limit);
    }
    if (!page.h1_count) add(page.url, "h1_missing", "low", "H1 is missing");
    if (page.h1_count > 1) add(page.url, "h1_multiple", "low", "Multiple H1 elements");
    const types = page.schema_types.map(schemaTypeName);
    if (page.page_type === "product" && !types.includes("product")) add(page.url, "schema_missing", "mid", "Product schema is missing");
    if (page.page_type === "blog" && !types.some((type) => ["article", "blogposting", "newsarticle"].includes(type))) add(page.url, "schema_missing", "mid", "Article schema is missing");
    if (page.schema_errors?.length) add(page.url, "schema_error", "mid", page.schema_errors.join("; "));
    if ((page.images_missing_alt ?? 0) > 0) add(page.url, "img_alt_missing", "low", "Images missing alt: " + page.images_missing_alt);
    if ((page.page_type === "blog" && (page.word_count ?? 0) < 300) || (page.page_type === "collection" && (page.word_count ?? 0) < 50)) {
      add(page.url, "thin_content", "low", page.page_type === "blog" ? "Blog post has fewer than 300 words" : "Category introduction has fewer than 50 words");
    }
  }
  for (const page of rows.map((row) => row.page)) {
    if ((titleMap.get(page.title?.toLowerCase() ?? "")?.length ?? 0) > 1) add(page.url, "title_duplicate", "mid", "Duplicate page title");
    if ((descMap.get(page.meta_description?.toLowerCase() ?? "")?.length ?? 0) > 1) add(page.url, "desc_duplicate", "mid", "Duplicate meta description");
    const incoming = rows.some((row) => row.links.some((link) => link.url === page.url));
    if (page.page_type !== "home" && !incoming) add(page.url, "orphan", "low", "No internal links point to this page");
  }
  const pageUrls = new Set(rows.map((row) => row.page.url));
  for (const row of rows) for (const link of row.links) if (!pageUrls.has(link.url)) add(link.url, "not_in_sitemap", "low", "Linked page is not in the sitemap");
  const previous = new Map(oldIssues.map((issue) => [issue.url + "\n" + issue.rule, issue]));
  const ignore = config.seo?.ignore_rules ?? [];
  const result: SeoIssue[] = [];
  for (const [key, item] of issues) {
    const old = previous.get(key);
    result.push({ ...item, status: ignore.some((rule) => rule.url === item.url && rule.rule === item.rule) ? "ignored" : "open", first_seen: old?.first_seen ?? date, last_seen: date });
  }
  for (const [key, old] of previous) {
    if (issues.has(key)) continue;
    if (old.status === "fixed") {
      if (dateDiff(date, old.last_seen) <= 30) result.push(old);
    } else result.push({ ...old, status: "fixed", last_seen: date });
  }
  return result;
}

function blogs(rows: Parsed[], date: string, productUrls: ReadonlySet<string>, skus: JsonObject[]): BlogPost[] {
  return rows.flatMap(({ page, doc, links, lastmod }) => {
    if (page.page_type !== "blog" || page.status_code >= 400) return [];
    const ld = jsonLd(doc);
    const article = ld.find((item) => asList(item["@type"]).some((type) => /article|blogposting/i.test(String(type)))) ?? {};
    const time = walk(doc, (n) => n.name === "time" && !!attr(n, "datetime"))[0];
    const author = article.author && typeof article.author === "object" ? (article.author as JsonObject).name : article.author;
    const productLinks = links.map((link) => link.url).filter((url) => productUrls.has(cleanUrl(url) ?? url));
    const internal = links.map((link) => link.url).filter((url) => rows.some((row) => row.page.url === url) && !productUrls.has(cleanUrl(url) ?? url));
    const published = meta(doc, "article:published_time") ?? (typeof article.datePublished === "string" ? article.datePublished : null) ?? attr(time, "datetime") ?? lastmod ?? date;
    const outline = walk(area(doc), (n) => /^h[2-4]$/.test(n.name ?? ""), OMIT).map((n) => text(n)).filter(Boolean);
    const tags = walk(doc, (n) => n.name === "meta" && attr(n, "property")?.toLowerCase() === "article:tag")
      .map((n) => attr(n, "content")).filter((value): value is string => !!value).sort(compareKeys);
    const productHandles = new Map(skus.map((sku) => [cleanUrl(String(sku.url ?? "")) ?? "", String(sku.handle ?? "")]));
    const publishedDay = isoDay(published, date);
    const wordCount = page.word_count;
    return [{
      url: page.url, slug: urlSlug(page.url),
      title: page.h1 ?? page.title ?? "", published_at: publishedDay,
      updated_at: (typeof article.dateModified === "string" ? article.dateModified : undefined) || meta(doc, "article:modified_time") || lastmod
        ? isoDay((typeof article.dateModified === "string" ? article.dateModified : undefined) ?? meta(doc, "article:modified_time") ?? lastmod, publishedDay) : null,
      category: meta(doc, "article:section"), author: typeof author === "string" ? author : meta(doc, "author"), tags,
      meta_description: page.meta_description, word_count: wordCount, reading_minutes: wordCount === null ? null : Math.max(1, Math.ceil(wordCount / 200)),
      outline, has_faq: ld.some((item) => asList(item["@type"]).some((type) => /faqpage/i.test(String(type)))),
      featured_image: cleanUrl(meta(doc, "og:image") ?? "", page.url), primary_keyword: meta(doc, "keywords"),
      links_internal: [...new Set(internal)].sort(compareKeys),
      links_products: [...new Set(productLinks.map((url) => productHandles.get(cleanUrl(url) ?? "") ?? urlSlug(url)))].sort(compareKeys),
      links_in: rows.filter((row) => row.links.some((link) => link.url === page.url)).length, last_crawled: date,
    }];
  });
}
function productDetails(rows: Parsed[], date: string): ProductDetails[] {
  const result = rows.flatMap(({ page, doc, links }) => {
    if (page.page_type !== "product") return [];
    const ld = jsonLd(doc);
    const product = ld.find((item) => hasSchemaType(item, "product")) ?? {};
    const rating = product.aggregateRating && typeof product.aggregateRating === "object" ? product.aggregateRating as JsonObject : {};
    const breadcrumb = ld.find((item) => hasSchemaType(item, "breadcrumblist"));
    const jsonCrumbs = breadcrumb ? asObjects(breadcrumb.itemListElement).flatMap((item) => {
      const nested = item.item && typeof item.item === "object" ? item.item as JsonObject : {};
      return typeof (item.name ?? nested.name) === "string" ? [String(item.name ?? nested.name)] : [];
    }) : [];
    const breadcrumbRoot = walk(doc, (node) => classTokens(node).includes("breadcrumbs")
      || (node.name === "nav" && /breadcrumb/i.test(attr(node, "aria-label") ?? "")), OMIT)[0];
    const htmlCrumbs = breadcrumbRoot ? walk(breadcrumbRoot, (node) => node.name === "li").map((node) => text(node)).filter(Boolean) : [];
    const crumbs = jsonCrumbs.length ? jsonCrumbs : htmlCrumbs;
    const galleryRoot = walk(doc, (node) => {
      const classes = classTokens(node);
      return classes.some((name) => /^(gallery-placeholder|fotorama|product-gallery)$/.test(name))
        || (classes.includes("product") && classes.includes("media"));
    }, OMIT)[0] ?? doc;
    const htmlImages = walk(galleryRoot, (node) => node.name === "img", OMIT).flatMap((node) => {
      const source = attr(node, "data-zoom-image") ?? attr(node, "data-large-image") ?? attr(node, "data-src")
        ?? attr(node, "data-original") ?? attr(node, "src") ?? attr(node, "srcset")?.split(/\s|,/)[0] ?? null;
      return source ? [source] : [];
    });
    const imageValues = [
      ...htmlImages,
      ...asList(product.image).flatMap((value) => {
        if (typeof value === "string") return [value];
        if (value && typeof value === "object") {
          const image = value as JsonObject;
          return [image.url, image.contentUrl].filter((url): url is string => typeof url === "string");
        }
        return [];
      }),
    ];
    const images = [...new Set(imageValues.map((url) => cleanUrl(url, page.url)).filter((url): url is string => !!url))];
    const related = links.filter((link) => rows.find((row) => row.page.url === link.url)?.page.page_type === "product")
      .map((link) => urlSlug(link.url));
    const body = text(area(doc));
    const shipping = body.match(/[^.!?。！？]*(?:free\s+shipping|shipping[^.!?。！？]{0,60}|配送[^。！？]{0,60})[^.!?。！？]*/i)?.[0]?.trim() ?? null;
    const badges = walk(area(doc), (node) => /badge|label/i.test(attr(node, "class") ?? ""), OMIT).map((node) => text(node)).filter(Boolean);
    let ratingValue = finiteNumber(rating.ratingValue);
    if (ratingValue === null) {
      const valueNode = walk(doc, (node) => attr(node, "itemprop")?.toLowerCase() === "ratingvalue", OMIT)[0];
      ratingValue = finiteNumber(attr(valueNode, "content") ?? (valueNode ? text(valueNode) : null));
    }
    if (ratingValue === null) {
      const ratingNode = walk(doc, (node) => classTokens(node).includes("rating-result") && !!attr(node, "title"), OMIT)[0];
      const title = attr(ratingNode, "title") ?? "";
      const match = title.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      if (match) {
        const parsed = Number(match[0]);
        ratingValue = title.includes("%") ? parsed * 5 / 100 : parsed;
      }
    }
    const reviewNode = walk(doc, (node) => ["reviewcount", "ratingcount"].includes((attr(node, "itemprop") ?? "").toLowerCase()), OMIT)[0];
    const reviewText = reviewNode ? attr(reviewNode, "content") ?? text(reviewNode) : "";
    const reviewMatch = body.match(/([\d,]+)\s*(?:reviews?|ratings?)/i) ?? body.match(/(?:reviews?|ratings?)\s*\(([\d,]+)\)/i);
    const reviewCount = finiteNumber(rating.reviewCount ?? rating.ratingCount) ?? finiteNumber(reviewText) ?? (reviewMatch ? finiteNumber(reviewMatch[1]?.replace(/,/g, "")) : null);
    return [{
      handle: urlSlug(page.url),
      short_description: page.meta_description ?? (typeof product.description === "string" ? product.description : null),
      rating: ratingValue,
      review_count: reviewCount !== null && Number.isInteger(reviewCount) ? reviewCount : null,
      breadcrumbs: crumbs, gallery: images, related_handles: [...new Set(related)], badges: [...new Set(badges)], shipping_note: shipping, last_crawled: date,
    }];
  });
  return [...new Map(result.map((item) => [item.handle, item])).values()];
}
function categories(config: SiteConfig, rows: Parsed[], skus: JsonObject[], date: string): Category[] {
  const result = new Map<string, Category>();
  const counts = (slug: string) => {
    const matches = skus.filter((row) => row.category === slug || (Array.isArray(row.categories) && row.categories.includes(slug)));
    return { sku_count: matches.length, product_count: new Set(matches.map((row) => String(row.handle))).size, in_stock_count: matches.filter((row) => row.stock_status === "in_stock").length };
  };
  if (config.categories.mode === "manual") for (const item of config.categories.manual ?? []) {
    result.set(item.slug, { slug: item.slug, name: item.name, url: item.url, parent: null, source: "manual", ...counts(item.slug), last_seen: date });
  } else if (config.categories.mode === "feed") {
    const slugs = new Set(skus.flatMap((row) => [row.category, ...(Array.isArray(row.categories) ? row.categories : [])]).map(String).filter(Boolean));
    for (const slug of slugs) {
      const collection = rows.find((row) => row.page.page_type === "collection" && new URL(row.page.url).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.(html?|php)$/i, "").toLowerCase() === slug.toLowerCase());
      const name = collection?.page.h1 ?? collection?.page.title ?? slug.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
      result.set(slug, { slug, name, url: collection?.page.url ?? "", parent: null, source: "feed", ...counts(slug), last_seen: date });
    }
  } else for (const row of rows) {
    if (row.page.page_type !== "collection" || (config.categories.url_pattern && !pattern(row.page.url, config.categories.url_pattern.split(/\s*,\s*/)))) continue;
    const path = new URL(row.page.url).pathname.split("/").filter(Boolean);
    const slug = path.at(-1) ?? "";
    if (!slug) continue;
    result.set(slug, { slug, name: row.page.h1 ?? row.page.title ?? slug, url: row.page.url, parent: path.length > 2 ? path.at(-2)! : null, source: "url_rule", ...counts(slug), intro_text_words: row.page.word_count, last_seen: date });
  }
  return [...result.values()].sort((a, b) => compareKeys(a.slug, b.slug));
}
function linkRows(rows: Parsed[], productUrls: ReadonlySet<string>, blog: BlogRecognition): SeoLink[] {
  const pageTypes = new Map(rows.map((row) => [row.page.url, row.page.page_type]));
  const result = new Map<string, SeoLink>();
  for (const row of rows) for (const link of row.links) {
    const type = pageTypes.get(link.url) ?? (productUrls.has(cleanUrl(link.url) ?? link.url) ? "product" : pageType(link.url, productUrls, undefined, new Set(), undefined, blog));
    const value: SeoLink = { from: row.page.url, to: link.url, anchor: link.anchor, to_type: type === "product" ? "product" : type === "collection" ? "collection" : type === "blog" ? "blog" : "page", ...(link.nofollow ? { nofollow: true } : {}) };
    result.set(value.from + "\n" + value.to + "\n" + value.anchor, value);
  }
  return [...result.values()];
}

export async function runWeekly(projectPath: string, config: SiteConfig, options: WeeklyOptions = {}): Promise<WeeklyResult> {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (options.only && !STEPS.includes(options.only as WeeklyStep)) return { status: "failed", counts: {}, errors: ["不支持的 weekly 步骤：" + options.only] };
  const selected = options.only ? [options.only as WeeklyStep] : [...STEPS];
  const skuRows = await readJsonl(path.join(projectPath, PATHS.skus));
  const productUrls = new Set(skuRows.map((row) => cleanUrl(String(row.url ?? ""))).filter((url): url is string => !!url));
  const categorySlugs = new Set(skuRows.flatMap((row) => [row.category, ...(Array.isArray(row.categories) ? row.categories : [])]).map(String));
  const crawlResult = await crawl(config, date, productUrls, categorySlugs);
  const rows = crawlResult.rows;
  const blog: BlogRecognition = {
    sitemapUrls: crawlResult.blogUrls,
    urlPatterns: config.content?.blog_url_patterns ?? [],
    legacyUrlPatterns: config.crawl.blog_url_patterns ?? [],
  };
  const errors = [...crawlResult.errors];
  const denominator = rows.length + errors.length;
  if (!rows.length || (denominator > 0 && errors.length / denominator > 0.2)) return { status: "failed", counts: {}, errors: errors.length ? errors : ["抓取结果为空，未覆盖现有数据。"] };
  const oldIssues = selected.includes("issues") ? await readJsonl(path.join(projectPath, PATHS.seoIssues)) as unknown as SeoIssue[] : [];
  const issues = selected.includes("issues") ? makeIssues(rows, oldIssues, config, date) : [];
  const output = async (step: WeeklyStep, relative: string, data: object[], schema: string, counts: Record<string, number>) => {
    if (!selected.includes(step)) return;
    options.onProgress?.(step, "正在生成 " + step);
    if (!data.length) { errors.push(step + " 结果为空，未覆盖现有数据。"); return; }
    await writeJsonl(path.join(projectPath, relative), data as Record<string, unknown>[], schema);
    counts[step] = data.length;
  };
  const counts: Record<string, number> = {};
  await output("pages", PATHS.seoPages, rows.map((row) => ({ ...row.page, links_internal_in: rows.reduce((n, candidate) => n + candidate.links.filter((link) => link.url === row.page.url).length, 0) })), "seo_page", counts);
  await output("issues", PATHS.seoIssues, issues, "seo_issue", counts);
  await output("links", PATHS.seoLinks, linkRows(rows, productUrls, blog), "seo_link", counts);
  await output("blog", PATHS.blogIndex, blogs(rows, date, productUrls, skuRows), "blog_post", counts);
  await output("product_details", PATHS.productDetails, productDetails(rows, date), "product_details", counts);
  if (selected.includes("categories")) {
    options.onProgress?.("categories", "正在生成 categories");
    const data = categories(config, rows, skuRows, date);
    if (!data.length) errors.push("categories 结果为空，未覆盖现有数据。");
    else { await atomicWrite(path.join(projectPath, PATHS.categories), JSON.stringify(data, null, 2) + "\n"); counts.categories = data.length; }
  }
  const failed = crawlResult.attempts > 0 && errors.filter((error) => !error.endsWith("结果为空，未覆盖现有数据。")).length / Math.max(1, denominator) > 0.2;
  if (failed) return { status: "failed", counts: {}, errors };
  return { status: errors.length ? Object.keys(counts).length ? "partial" : "failed" : "ok", counts, errors };
}
