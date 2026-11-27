import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, expect, it, vi } from "vitest";
import { collectWooSitemapHtml } from "../src/crawl/woo-sitemap-html";
import { collectWooStoreApi } from "../src/crawl/woo-store-api";
import { runWeekly } from "../src/jobs/weekly";

const BASE = "http://127.0.0.1:43141";
const roots: string[] = [];
const html = "<html><head><title>Synthetic Product</title></head><body><main><h1>Product</h1></main></body></html>";

function config(): SiteConfig {
  const schedule = { enabled: false, time: "00:00" };
  return {
    schema_version: "1.1", domain: "synthetic.example.test", base_url: BASE,
    platform: "other", currency: "USD", locale: "en-US", timezone: "UTC",
    brand: { name: "Synthetic Catalog" }, sitemaps: [`${BASE}/sitemap.xml`],
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0, max_pages: 20 },
    categories: { mode: "manual", manual: [] }, workspace_folders: [],
    schedule: { daily: schedule, validate: schedule, weekly: schedule, readme: schedule, monthly: schedule,
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } },
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-boundary-audit-"));
  roots.push(root);
  await mkdir(path.dirname(path.join(root, PATHS.skus)), { recursive: true });
  await mkdir(path.dirname(path.join(root, PATHS.seoPages)), { recursive: true });
  await writeFile(path.join(root, PATHS.skus), "", "utf8");
  return root;
}

async function pages(root: string): Promise<Array<{ url: string; status_code: number; final_url?: string;
  redirect_chain?: string[]; indexable?: boolean; canonical_status?: string }>> {
  const content = await readFile(path.join(root, PATHS.seoPages), "utf8");
  return content.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function route(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reports a Sitemap HTTP 403 and keeps the previous SEO page file", async () => {
  const prior = { url: `${BASE}/products/previous`, status_code: 200, title: "Previous" };
  const root = await project();
  await writeFile(path.join(root, PATHS.seoPages), `${JSON.stringify(prior)}\n`, "utf8");
  const requests = vi.fn(async () => new Response("forbidden", { status: 403 }));
  vi.stubGlobal("fetch", requests);
  const site = config();
  site.crawl.user_agent = "SyntheticAuditBot/1.0";
  const result = await runWeekly(root, site, { date: "2026-11-27", only: "pages" });
  expect(result.status).toBe("failed");
  expect(result.errors.join(" ")).toMatch(/HTTP 403/u);
  expect(requests).toHaveBeenCalledWith(`${BASE}/sitemap.xml`, expect.objectContaining({
    headers: { "user-agent": "SyntheticAuditBot/1.0" },
  }));
  expect(await pages(root)).toEqual([prior]);
});

it("retries a product page HTTP 503 twice and indexes the eventual 200 response", async () => {
  let pageRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (route(input).pathname === "/sitemap.xml")
      return new Response(`<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>`);
    pageRequests += 1;
    return pageRequests < 3 ? new Response("unavailable", { status: 503 }) : new Response(html);
  }));
  const root = await project();
  const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
  expect(pageRequests).toBe(3);
  expect(result.status).toBe("ok");
  expect(await pages(root)).toEqual([expect.objectContaining({ url: `${BASE}/products/demo`, status_code: 200 })]);
});

it("spaces Sitemap and product requests according to the configured crawl rate", async () => {
  const requestedAt: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    requestedAt.push(Date.now());
    return route(input).pathname === "/sitemap.xml"
      ? new Response(`<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>`)
      : new Response(html);
  }));
  const root = await project();
  const site = config();
  site.crawl.rate_limit_ms = 30;
  await runWeekly(root, site, { date: "2026-11-27", only: "pages" });
  expect(requestedAt).toHaveLength(2);
  expect(requestedAt[1]! - requestedAt[0]!).toBeGreaterThanOrEqual(20);
});

it("reports a page timeout after retries rather than silently treating it as a fetched page", async () => {
  let pageRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (route(input).pathname === "/sitemap.xml")
      return new Response(`<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>`);
    pageRequests += 1;
    throw new Error("synthetic timeout");
  }));
  const root = await project();
  const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
  expect(pageRequests).toBe(3);
  expect(result.status).toBe("failed");
  expect(result.errors.join(" ")).toMatch(/synthetic timeout/u);
});

it("records the original and final URL when a product page redirects", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = route(input);
    if (url.pathname === "/sitemap.xml")
      return new Response(`<urlset><url><loc>${BASE}/products/old</loc></url></urlset>`);
    if (url.pathname === "/products/old")
      return new Response("", { status: 301, headers: { location: "/products/new" } });
    return new Response(html);
  }));
  const root = await project();
  const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
  expect(result.status).toBe("ok");
  expect(await pages(root)).toEqual([expect.objectContaining({ url: `${BASE}/products/old`, final_url: `${BASE}/products/new`,
    redirect_chain: [`${BASE}/products/old`], status_code: 200 })]);
});

it("deduplicates tracking-parameter variants from a Sitemap before page fetch", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = route(input);
    requests.push(url.href);
    if (url.pathname === "/sitemap.xml") return new Response(`<urlset>
      <url><loc>${BASE}/products/demo?utm_source=one</loc></url>
      <url><loc>${BASE}/products/demo?utm_source=two</loc></url>
      <url><loc>${BASE}/products/demo</loc></url></urlset>`);
    return new Response(html);
  }));
  const root = await project();
  const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
  expect(result.counts).toMatchObject({ sitemap_urls: 1, crawled: 1 });
  expect(requests.filter((url) => url.includes("/products/demo"))).toEqual([`${BASE}/products/demo`]);
});

it("keeps scheme, host and trailing-slash variants visible but marks noncanonical pages nonindexable", async () => {
  const primary = `${BASE}/products/demo`;
  const variants = [primary, `${BASE}/products/demo/`, "https://127.0.0.1:43141/products/demo",
    "http://www.synthetic.example.test/products/demo"];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => route(input).pathname === "/sitemap.xml"
    ? new Response(`<urlset>${[...variants, `${primary}?utm_source=ad`]
      .map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`)
    : new Response(`<html><head><title>Synthetic</title><link rel="canonical" href="${primary}"></head>
      <body><main><h1>Product</h1></main></body></html>`)));
  const root = await project();
  const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
  const rows = await pages(root);
  expect(result.counts).toMatchObject({ sitemap_urls: 4, crawled: 4 });
  expect(rows.map((row) => row.url).sort()).toEqual([...variants].sort());
  expect(rows.find((row) => row.url === primary)).toMatchObject({ canonical_status: "self", indexable: true });
  expect(rows.filter((row) => row.url !== primary)).toEqual([
    expect.objectContaining({ canonical_status: "other", indexable: false }),
    expect.objectContaining({ canonical_status: "other", indexable: false }),
    expect.objectContaining({ canonical_status: "other", indexable: false }),
  ]);
});

it("fails without partial Store API rows when the product page count exceeds the 200-page safety cap", async () => {
  let productPages = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = route(input);
    const isProduct = url.pathname.endsWith("/products") && !url.searchParams.has("type");
    if (isProduct) productPages += 1;
    return new Response("[]", { headers: { "content-type": "application/json",
      "x-wp-totalpages": isProduct ? "201" : "1" } });
  }));
  await expect(collectWooStoreApi({ base_url: "https://shop.example.test/", currency: "USD" }))
    .rejects.toMatchObject({ code: "FEED_FETCH_FAILED", message: expect.stringContaining("安全上限") });
  expect(productPages).toBe(200);
});

it("rejects a Sitemap HTML fallback above configured max_pages before fetching products", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = route(input);
    requests.push(url.pathname);
    return new Response(`<urlset><url><loc>https://shop.example.test/product/a</loc></url>
      <url><loc>https://shop.example.test/product/b</loc></url></urlset>`);
  }));
  await expect(collectWooSitemapHtml({ base_url: "https://shop.example.test/", currency: "USD",
    sitemaps: ["https://shop.example.test/product-sitemap.xml"],
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0, max_pages: 1 } }))
    .rejects.toMatchObject({ code: "FEED_FETCH_FAILED", message: expect.stringContaining("抓取上限") });
  expect(requests).toEqual(["/product-sitemap.xml"]);
});

it("rejects a Woo Sitemap chain beyond its 40-Sitemap safety cap", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const match = /^\/product-sitemap-(\d+)\.xml$/u.exec(route(input).pathname);
    if (!match) throw new Error("Unexpected synthetic request");
    requests += 1;
    const next = Number(match[1]) + 1;
    return new Response(`<sitemapindex><sitemap><loc>https://shop.example.test/product-sitemap-${next}.xml</loc>
      </sitemap></sitemapindex>`);
  }));
  await expect(collectWooSitemapHtml({ base_url: "https://shop.example.test/", currency: "USD",
    sitemaps: ["https://shop.example.test/product-sitemap-0.xml"],
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0 } }))
    .rejects.toMatchObject({ code: "FEED_FETCH_FAILED", message: expect.stringContaining("安全上限") });
  expect(requests).toBe(40);
});
