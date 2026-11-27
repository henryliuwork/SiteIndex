import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CSV_HEADERS, PATHS, pathsFor, type SiteConfig, type SkuRecord } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonl, writeJsonl } from "../src/io/jsonl";
import { writeCsv } from "../src/io/csv";
import { runDaily, type DailySnapshot } from "../src/jobs/daily";
import { createCoreService } from "../src/service";

const roots: string[] = [];
const paths = pathsFor("legacy");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ProductFixture {
  path: string;
  name: string;
  sku?: string;
  price?: number;
}

function stubProductSite(products: readonly ProductFixture[]): void {
  const sitemap = `<urlset>${products.map((product) => `<url><loc>https://shop.example.test${product.path}</loc></url>`).join("")}</urlset>`;
  const byPath = new Map(products.map((product) => [product.path, product]));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.pathname === "/sitemap.xml") return new Response(sitemap, { status: 200, headers: { "content-type": "application/xml" } });
    const product = byPath.get(target.pathname);
    if (!product) return new Response("missing synthetic page", { status: 404, headers: { "content-type": "text/html" } });
    const productLd = {
      "@type": "Product",
      name: product.name,
      ...(product.sku ? { sku: product.sku } : {}),
      ...(product.price !== undefined ? { offers: { "@type": "Offer", price: product.price, priceCurrency: "USD" } } : {}),
      image: "/images/synthetic-product.jpg",
    };
    const html = `<html><head><title>${product.name}</title><script type="application/ld+json">${JSON.stringify(productLd)}</script></head><body><main><h1>${product.name}</h1></main></body></html>`;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }));
}

function syntheticConfig(): SiteConfig {
  const jobSchedule = { enabled: false, days: [], time: "00:00" as const };
  return {
    schema_version: "1.0",
    domain: "shop.example.test",
    base_url: "https://shop.example.test",
    platform: "other",
    currency: "USD",
    locale: "en-US",
    timezone: "UTC",
    brand: { name: "Synthetic Shop" },
    sitemaps: ["https://shop.example.test/sitemap.xml"],
    crawl: { adapter: "gmc_feed", feed_url: "https://feed.example.test/products.xml", rate_limit_ms: 0, max_pages: 200 },
    categories: { mode: "feed" },
    workspace_folders: [],
    schedule: {
      daily: jobSchedule, validate: jobSchedule, weekly: jobSchedule, readme: jobSchedule, monthly: jobSchedule,
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false },
    },
  };
}

async function makeProject(config: SiteConfig): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "siteindex-p7-catalog-"));
  roots.push(project);
  await mkdir(path.join(project, paths.index), { recursive: true });
  await writeFile(path.join(project, paths.site), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (const relative of [
    PATHS.skus, PATHS.inventoryLatest, PATHS.productsView, PATHS.skuStockView, PATHS.productDetails,
    PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex, PATHS.keywords,
    PATHS.edmCampaigns, PATHS.runs,
  ]) {
    const file = path.join(project, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "", "utf8");
  }
  await mkdir(path.join(project, paths.eventsDir), { recursive: true });
  await writeFile(path.join(project, paths.dailySummary), "date,category,total,in_stock,out_of_stock,preorder,unknown\n", "utf8");
  await writeCsv(path.join(project, paths.skuMedia), [], CSV_HEADERS.skuMedia, ["sku"]);
  await writeCsv(path.join(project, paths.skuTags), [], CSV_HEADERS.skuTags, ["sku"]);
  return project;
}

function pageSku(sku: string, url: string, date: string): SkuRecord {
  return {
    sku, product_id: sku, source: "page", handle: sku.toLowerCase(), title: `Synthetic ${sku}`, variant_title: null,
    url, category: "uncategorized", categories: ["uncategorized"], category_source: "none", price: 12.5,
    compare_at_price: null, currency: "USD", image_url: null, status: "active", first_seen: date,
    last_seen: date, updated_at: date,
  };
}

function feedSnapshot(sku: string, url: string, price: number): DailySnapshot {
  return {
    sku, product_id: `feed-${sku}`, handle: sku.toLowerCase(), title: `Feed ${sku}`, variant_title: null,
    url, category: "synthetic", categories: ["synthetic"], category_source: "feed", price,
    compare_at_price: null, currency: "USD", image_url: null, stock_status: "in_stock", qty: null,
  };
}

describe("P7 page-discovered SKU catalog", () => {
  it("indexes 200 synthetic product pages, leaves incomplete pages as catalog-gap todos, and builds product views", async () => {
    const complete = Array.from({ length: 197 }, (_, index): ProductFixture => ({
      path: `/products/demo-${String(index + 1).padStart(3, "0")}`,
      name: `Synthetic product ${index + 1}`,
      sku: `DEMO-PAGE-${String(index + 1).padStart(3, "0")}`,
      price: index + 1,
    }));
    const products: ProductFixture[] = [
      ...complete,
      { path: "/products/no-price", name: "Synthetic product without price", sku: "DEMO-NO-PRICE" },
      { path: "/products/no-sku", name: "Synthetic product without SKU", price: 4 },
      { path: "/products/no-sku-or-price", name: "Synthetic product without SKU or price" },
    ];
    stubProductSite(products);
    const config = syntheticConfig();
    const project = await makeProject(config);
    const api = createCoreService({
      resolveProject: () => project,
      deviceId: "p7-test-device",
      cacheDir: path.join(project, "cache"),
    });

    const result = await api.runJob({ projectPath: project, job: "weekly", trigger: "manual", only: "pages" }, () => undefined);

    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ sitemap_urls: 200, crawled: 200, pages: 200, page_catalog_changed: 197, catalog_gap: 3 });
    const skuRows = await readJsonl(path.join(project, paths.skus));
    expect(skuRows).toHaveLength(197);
    expect(skuRows.every((row) => row.source === "page")).toBe(true);
    expect(skuRows.map((row) => row.sku)).toEqual([...skuRows.map((row) => String(row.sku))].sort());
    expect(skuRows[0]).toMatchObject({ sku: "DEMO-PAGE-001", price: 1, currency: "USD" });
    const latest = await readJsonl(path.join(project, paths.inventoryLatest));
    expect(latest).toHaveLength(197);
    expect(latest.every((row) => row.stock_status === "unknown")).toBe(true);
    const productsView = await readJsonl(path.join(project, paths.productsView));
    expect(productsView).toHaveLength(197);
    const todoResult = await api.todos.list("synthetic-project");
    const gaps = todoResult.items.filter((item) => item.finding.rule_id === "catalog_gap");
    expect(gaps).toHaveLength(3);
    expect(gaps.every((item) => item.finding.severity === "high")).toBe(true);
    expect(gaps.map((item) => item.finding.detail).sort()).toEqual([
      "未能从页面结构提取必填字段：SKU、价格。",
      "未能从页面结构提取必填字段：SKU。",
      "未能从页面结构提取必填字段：价格。",
    ].sort());
  }, 30_000);

  it("lets daily feed data take over a page SKU by SKU or normalized URL without deleting prior history", async () => {
    const config = syntheticConfig();
    const firstDate = "2026-11-20";
    const persistentPageProject = await makeProject(config);
    const pageWithoutFeed = pageSku("DEMO-PAGE-PERSIST", "https://shop.example.test/products/persist", firstDate);
    await writeJsonl(path.join(persistentPageProject, paths.skus), [pageWithoutFeed as unknown as Record<string, unknown>], "sku");
    await writeJsonl(path.join(persistentPageProject, paths.inventoryLatest), [
      { sku: pageWithoutFeed.sku, stock_status: "unknown", qty: null, since: firstDate, checked_at: `${firstDate}T00:00:00.000Z` },
    ], "inventory_latest");
    const persistentResult = await runDaily(persistentPageProject, [
      feedSnapshot("DEMO-OTHER-FEED", "https://shop.example.test/products/other", 9),
    ], { date: "2026-11-21", now: new Date("2026-11-21T12:00:00.000Z") });
    expect(persistentResult.status).toBe("partial");
    expect((await readJsonl(path.join(persistentPageProject, paths.skus))).find((row) => row.sku === pageWithoutFeed.sku))
      .toMatchObject({ source: "page", status: "active" });
    expect((await readJsonl(path.join(persistentPageProject, paths.inventoryLatest))).find((row) => row.sku === pageWithoutFeed.sku))
      .toMatchObject({ stock_status: "unknown" });

    const sameSkuProject = await makeProject(config);
    await writeJsonl(path.join(sameSkuProject, paths.skus), [pageSku("DEMO-SAME", "https://shop.example.test/products/same", firstDate) as unknown as Record<string, unknown>], "sku");
    await writeJsonl(path.join(sameSkuProject, paths.inventoryLatest), [
      { sku: "DEMO-SAME", stock_status: "unknown", qty: null, since: firstDate, checked_at: `${firstDate}T00:00:00.000Z` },
    ], "inventory_latest");
    const sameResult = await runDaily(sameSkuProject, [feedSnapshot("DEMO-SAME", "https://shop.example.test/products/same?utm_source=feed", 15)], {
      date: "2026-11-21", now: new Date("2026-11-21T12:00:00.000Z"),
    });
    expect(sameResult.status).toBe("ok");
    const sameSkuRows = await readJsonl(path.join(sameSkuProject, paths.skus));
    expect(sameSkuRows).toHaveLength(1);
    expect(sameSkuRows[0]).toMatchObject({ sku: "DEMO-SAME", price: 15, status: "active", first_seen: firstDate });
    expect(sameSkuRows[0]).not.toHaveProperty("source");

    const replacementProject = await makeProject(config);
    const oldPage = pageSku("DEMO-OLD-PAGE", "https://shop.example.test/products/shared?utm_source=page", firstDate);
    await writeJsonl(path.join(replacementProject, paths.skus), [oldPage as unknown as Record<string, unknown>], "sku");
    await writeJsonl(path.join(replacementProject, paths.inventoryLatest), [
      { sku: oldPage.sku, stock_status: "unknown", qty: null, since: firstDate, checked_at: `${firstDate}T00:00:00.000Z` },
    ], "inventory_latest");
    await writeFile(path.join(replacementProject, paths.dailySummary),
      `date,category,total,in_stock,out_of_stock,preorder,unknown\n${firstDate},_all,1,0,0,0,1\n`, "utf8");
    const historicalEvent = {
      date: firstDate, sku: oldPage.sku, type: "new_sku", from: null, to: 12.5,
      category: oldPage.category, title: oldPage.title,
    };
    const eventFile = path.join(replacementProject, paths.eventsDir, "2026-11.jsonl");
    await writeJsonl(eventFile, [historicalEvent], "inventory_event");

    const replacementResult = await runDaily(replacementProject, [
      feedSnapshot("DEMO-FEED-NEW", "https://shop.example.test/products/shared?utm_campaign=feed", 16),
    ], { date: "2026-11-21", now: new Date("2026-11-21T12:00:00.000Z") });
    expect(replacementResult.status).toBe("ok");
    const replacementRows = await readJsonl(path.join(replacementProject, paths.skus));
    expect(replacementRows.find((row) => row.sku === oldPage.sku)).toMatchObject({
      source: "page", status: "removed", removed_reason: "superseded_by_feed",
    });
    expect(replacementRows.find((row) => row.sku === "DEMO-FEED-NEW")).toMatchObject({ status: "active", price: 16 });
    expect(replacementRows.find((row) => row.sku === "DEMO-FEED-NEW")).not.toHaveProperty("source");
    const currentInventory = await readJsonl(path.join(replacementProject, paths.inventoryLatest));
    expect(currentInventory.map((row) => row.sku)).toEqual(["DEMO-FEED-NEW"]);
    const events = await readJsonl(eventFile);
    expect(events).toEqual(expect.arrayContaining([
      historicalEvent,
      expect.objectContaining({ sku: oldPage.sku, type: "removed_sku", from: "active", to: "removed" }),
    ]));
    const summaries = await readFile(path.join(replacementProject, paths.dailySummary), "utf8");
    expect(summaries).toContain(`${firstDate},_all,1,0,0,0,1`);
    expect(summaries).toContain("2026-11-21,_all,1,1,0,0,0");
  }, 30_000);
});
