import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CSV_HEADERS, PATHS, type Category, type SkuStockView, type StockStatus } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../src/service";
import { readCsv, writeCsv } from "../src/io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../src/io/jsonl";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];
const STOCK_FIELDS = [
  "sku", "title", "variant_title", "category", "price", "stock_status", "since", "days_in_status",
  "online_rate_7d", "online_rate_30d", "history_30d", "changes_30d", "last_change", "last_change_at",
] as const;

function stockRow(sku: string, title: string, status: StockStatus, category = "bird-feeders"): SkuStockView {
  return {
    sku,
    title,
    variant_title: null,
    category,
    price: 12.5,
    stock_status: status,
    since: "2026-10-19",
    days_in_status: 3,
    online_rate_7d: 0.75,
    online_rate_30d: 0.8,
    history_30d: "i".repeat(30),
    changes_30d: 0,
    last_change: null,
    last_change_at: null,
  };
}

async function makeProject(): Promise<{ root: string; projectPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-service-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  return { root, projectPath };
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: (id) => id === "fixture" ? projectPath : path.join(projectPath, "missing"),
    deviceId: "test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createCoreService initial namespaces", () => {
  it("reads project details, inventory trends and daily reports from the expected project", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const [detail, inventory] = await Promise.all([
      api.projects.get("fixture"),
      api.inventory.summary("fixture", 30),
    ]);
    const legacy14DayInventory = await api.inventory.summary("fixture", 14);

    expect(detail.summary).toMatchObject({
      id: "fixture",
      path: projectPath,
      domain: detail.config.domain,
      sku_count: 19,
      product_count: 17,
      sync: { state: "ok", job: "weekly" },
      is_runner: false,
    });
    expect(inventory.as_of).toBe("2026-10-21");
    expect(inventory.trend.dates).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(legacy14DayInventory.trend).toEqual(inventory.trend);
    expect(inventory.category_rates.length).toBeGreaterThan(0);
    expect(inventory.category_source).toBe(detail.config.categories?.mode ?? "feed");
    expect(await api.inventory.dailyReport("fixture", "2026-10-21")).toContain("库存日报");
    expect(await api.inventory.dailyReport("fixture", "2026-10-18")).toBeNull();
  }, 30_000);

  it("serves 14, 30, 60, 90 and all recorded business dates through CoreService", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const dailySummaryPath = path.join(projectPath, PATHS.dailySummary);
    const businessDates = Array.from({ length: 100 }, (_, index) =>
      new Date(Date.UTC(2026, 0, 1 + index * 2)).toISOString().slice(0, 10));
    const historyRows = businessDates.flatMap((date, index) => {
      const inStock = index % 2 === 0 ? 2 : 1;
      const categoryRow = { date, category: "bird-feeders", total: 2, in_stock: inStock, out_of_stock: 2 - inStock, preorder: 0, unknown: 0 };
      return [
        { ...categoryRow, category: "_all" },
        categoryRow,
      ];
    });
    await writeCsv(dailySummaryPath, historyRows, CSV_HEADERS.dailySummary, ["date", "category"]);
    api.invalidate(projectPath);

    const ranges = [14, 30, 60, 90, "all"] as const;
    const defaultSummary = await api.inventory.summary("fixture");
    const legacy14 = await api.inventory.summary("fixture", 14);
    expect(defaultSummary.trend).toEqual(legacy14.trend);

    for (const range of ranges) {
      const summary = await api.inventory.summary("fixture", range);
      const count = range === "all" ? businessDates.length : range;
      const expectedDates = businessDates.slice(-count);
      expect(summary.trend.dates).toEqual(expectedDates);
      expect(summary.trend.series).toEqual([{
        category: "bird-feeders",
        rates: expectedDates.map((date) => (businessDates.indexOf(date) % 2 === 0 ? 1 : 0.5)),
      }]);
    }

    const latestDate = businessDates.at(-1)!;
    await writeCsv(dailySummaryPath, [
      { date: latestDate, category: "_all", total: 1, in_stock: 1, out_of_stock: 0, preorder: 0, unknown: 0 },
      { date: latestDate, category: "bird-feeders", total: 1, in_stock: 1, out_of_stock: 0, preorder: 0, unknown: 0 },
    ], CSV_HEADERS.dailySummary, ["date", "category"]);
    api.invalidate(projectPath);
    for (const range of ranges) {
      expect((await api.inventory.summary("fixture", range)).trend.dates).toEqual([latestDate]);
    }
  }, 30_000);

  it("keeps null trend values for missing category business dates", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const dailySummaryPath = path.join(projectPath, PATHS.dailySummary);
    await writeCsv(dailySummaryPath, [
      { date: "2026-10-19", category: "alpha", total: 2, in_stock: 1, out_of_stock: 1, preorder: 0, unknown: 0 },
      { date: "2026-10-19", category: "_all", total: 2, in_stock: 1, out_of_stock: 1, preorder: 0, unknown: 0 },
      { date: "2026-10-20", category: "beta", total: 0, in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 },
      { date: "2026-10-20", category: "_all", total: 0, in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 },
    ], CSV_HEADERS.dailySummary, ["date", "category"]);
    api.invalidate(projectPath);

    const summary = await api.inventory.summary("fixture", 14);
    expect(summary.trend).toEqual({
      dates: ["2026-10-19", "2026-10-20"],
      series: [
        { category: "alpha", rates: [0.5, null] },
        { category: "beta", rates: [null, 0] },
      ],
    });
  });

  it("merges watched categories for display without changing inventory source data", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const legacy = await api.inventory.summary("fixture", 30);
    expect(legacy.category_rates.every((row) => !("watched" in row) && !("manual" in row))).toBe(true);

    const categoriesPath = path.join(projectPath, PATHS.categories);
    const dailySummaryPath = path.join(projectPath, PATHS.dailySummary);
    const skuStockPath = path.join(projectPath, PATHS.skuStockView);
    const fetchedCategories: Category[] = [
      { slug: "bird-feeders", name: "Bird Feeders", url: "https://shop.example.test/collections/bird-feeders/", parent: null, source: "feed", last_seen: "2026-10-21" },
      { slug: "garden-tools", name: "Garden Tools", url: "https://shop.example.test/collections/garden-tools/", parent: null, source: "feed", last_seen: "2026-10-21" },
      { slug: "empty-category", name: "Empty Category", url: "https://shop.example.test/collections/empty-category/", parent: null, source: "feed", last_seen: "2026-10-21" },
    ];
    await writeFile(categoriesPath, `${JSON.stringify(fetchedCategories, null, 2)}\n`, "utf8");
    await writeCsv(dailySummaryPath, [
      { date: "2026-10-21", category: "bird-feeders", total: 4, in_stock: 3, out_of_stock: 1, preorder: 0, unknown: 0 },
      { date: "2026-10-21", category: "garden-tools", total: 6, in_stock: 3, out_of_stock: 3, preorder: 0, unknown: 0 },
      { date: "2026-10-21", category: "legacy-only", total: 2, in_stock: 1, out_of_stock: 1, preorder: 0, unknown: 0 },
      { date: "2026-10-21", category: "_all", total: 12, in_stock: 7, out_of_stock: 5, preorder: 0, unknown: 0 },
      { date: "2026-10-21", category: "", total: 99, in_stock: 99, out_of_stock: 0, preorder: 0, unknown: 0 },
    ], CSV_HEADERS.dailySummary, ["date", "category"]);
    await writeJsonl(skuStockPath, [
      stockRow("SKU-A", "Bird product", "in_stock", "bird-feeders"),
      stockRow("SKU-B", "Garden product", "in_stock", "garden-tools"),
      stockRow("SKU-C", "Empty product", "in_stock", "empty-category"),
      stockRow("SKU-D", "Legacy product", "in_stock", "legacy-only"),
      stockRow("SKU-E", "Manual product", "in_stock", "manual-category"),
    ] as unknown as JsonRecord[], { primaryKey: ["sku"], fieldOrder: STOCK_FIELDS, floatFields: ["price", "online_rate_7d", "online_rate_30d"] });
    api.invalidate(projectPath);

    const initial = await api.projects.get("fixture");
    const watched = [
      { name: "Bird Feeders", slug: "tracked-bird-feeders", manual: false },
      { name: "Birds manually selected", slug: "bird-feeders", url: "https://shop.example.test/collections/other/", manual: true },
      { name: "Birds selected by URL", slug: "bird-feeders-url-alias", url: "https://shop.example.test/collections/bird-feeders/?source=watch", manual: true },
      { name: "Garden Tools", slug: "garden-tools-copy", url: "https://shop.example.test/collections/garden-tools-copy", manual: false },
      { name: "Legacy category", slug: "legacy-only", url: "https://shop.example.test/collections/legacy-only", manual: false },
      { name: "Manual category", slug: "manual-category", url: "https://shop.example.test/collections/manual-category", manual: true },
      { name: "   ", manual: true },
    ];
    await api.projects.updateConfig("fixture", { categories: { ...initial.config.categories, watched } });

    const sourceBeforeDisplayCalls = await Promise.all([
      readFile(dailySummaryPath),
      readFile(skuStockPath),
      readFile(categoriesPath),
    ]);
    const summary = await api.inventory.summary("fixture", 30);
    expect(summary.category_rates).toEqual([
      { category: "bird-feeders", rate: 0.75, total: 4, watched: true, manual: true },
      { category: "empty-category", rate: 0, total: 0, watched: false, manual: false },
      { category: "garden-tools", rate: 0.5, total: 6, watched: true, manual: false },
      { category: "legacy-only", rate: 0.5, total: 2, watched: true, manual: false },
      { category: "manual-category", rate: 0, total: 0, watched: true, manual: true },
    ]);
    expect(summary.kpis.find((item) => item.key === "total")?.value).toBe("12");

    const watchedRows = await api.inventory.listSkus("fixture", {
      page: 1, pageSize: 20, filters: { watched_only: true },
    });
    expect(watchedRows.rows.map((row) => row.category)).toEqual([
      "bird-feeders", "garden-tools", "legacy-only", "manual-category",
    ]);
    expect(await Promise.all([readFile(dailySummaryPath), readFile(skuStockPath), readFile(categoriesPath)]))
      .toEqual(sourceBeforeDisplayCalls);
    const validation = await api.files.validate("fixture");
    expect(validation.files.find((file) => file.path === PATHS.site)).toMatchObject({ status: "ok" });

    await api.projects.updateConfig("fixture", {
      categories: { ...initial.config.categories, watched: [...watched].reverse() },
    });
    await writeFile(categoriesPath, `${JSON.stringify([...fetchedCategories].reverse(), null, 2)}\n`, "utf8");
    api.invalidate(projectPath);
    expect((await api.inventory.summary("fixture", 30)).category_rates).toEqual(summary.category_rates);
  }, 30_000);

  it("preserves a readable Chinese feed failure reason in daily results and run logs", async () => {
    const { projectPath } = await makeProject();
    const configPath = path.join(projectPath, PATHS.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as { crawl: { feed_url?: string | string[] } };
    config.crawl.feed_url = "https://shop.example/private-feed";
    await writeFile(configPath, JSON.stringify(config));
    const message = "这个地址返回的是网页而不是商品 feed（可能需要登录，或是 Google 表格/后台页面的链接）。请填写 Merchant Center 数据源中的'抓取网址'。";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>login required</body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    })));

    const result = await service(projectPath).runJob(
      { projectPath, job: "daily", trigger: "manual", date: "2026-10-22" },
      () => undefined,
    );
    const run = (await readJsonl(path.join(projectPath, PATHS.runs))).find((row) => row.run_id === "2026-10-22-daily");

    expect(result).toMatchObject({ status: "failed", summary: `每日同步失败：${message}`, errors: [message] });
    expect(run).toMatchObject({ status: "failed", errors: [message] });
  }, 30_000);

  it("releases the Core lock after a partial weekly result", async () => {
    const { projectPath } = await makeProject();
    const configPath = path.join(projectPath, PATHS.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as import("@siteindex/shared").SiteConfig;
    config.base_url = "https://shop.example";
    config.sitemaps = ["https://shop.example/sitemap.xml"];
    config.crawl.rate_limit_ms = 0;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/sitemap.xml") {
        return new Response("<urlset><url><loc>https://shop.example/</loc></url></urlset>", { headers: { "content-type": "application/xml" } });
      }
      return new Response("<html><head><title>Sample home page</title><meta name=\"description\" content=\"A synthetic home page description.\"></head><body><main><h1>Sample home</h1><p>Sample content for lock cleanup coverage.</p></main></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }));

    const result = await service(projectPath).runJob(
      { projectPath, job: "weekly", trigger: "manual", date: "2026-10-28" },
      () => undefined,
    );
    const lockPath = path.join(projectPath, PATHS.lock);
    expect(result.status).toBe("partial");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJsonl(path.join(projectPath, PATHS.runs))).find((row) => row.run_id === result.runId))
      .toMatchObject({ status: "partial" });
  }, 20_000);

  it("releases the Core lock and records a failure when a job throws", async () => {
    const { projectPath } = await makeProject();
    const result = await service(projectPath).runJob(
      { projectPath, job: "design", trigger: "manual", date: "2026-10-28" },
      () => undefined,
    );
    expect(result.status).toBe("failed");
    await expect(readFile(path.join(projectPath, PATHS.lock), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJsonl(path.join(projectPath, PATHS.runs))).find((row) => row.job === "design"))
      .toMatchObject({ status: "failed", errors: [expect.stringContaining("executablePath")] });
  }, 20_000);

  it("paginates, sorts and filters SKU and product lists", async () => {
    const { projectPath } = await makeProject();
    await writeJsonl(path.join(projectPath, PATHS.skuStockView), [
      stockRow("SKU-A", "Alpha", "in_stock"),
      stockRow("SKU-B", "Beta", "out_of_stock", "bird-baths"),
      stockRow("SKU-C", "Gamma", "unknown"),
    ] as unknown as JsonRecord[], { primaryKey: ["sku"], fieldOrder: STOCK_FIELDS, floatFields: ["price", "online_rate_7d", "online_rate_30d"] });
    const api = service(projectPath);

    const skuPage = await api.inventory.listSkus("fixture", {
      page: 1, pageSize: 1, search: "a", sort: { field: "title", dir: "desc" }, filters: { status: "in_stock" },
    });
    expect(skuPage.total).toBe(1);
    expect(skuPage.rows[0]?.sku).toBe("SKU-A");

    const products = await api.products.list("fixture", {
      page: 1, pageSize: 0, filters: { stock: "in", tag: "fall", category: "bird-houses" },
    });
    expect(products.rows.map((row) => row.handle)).toEqual(["feeder-2"]);
  }, 20_000);

  it("returns product detail and tag counts, then writes normalized tags to all active variants", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const product = await api.products.get("fixture", "feeder-0");
    expect(product.product.handle).toBe("feeder-0");
    expect(product.skus.map((row) => row.sku)).toEqual(["KYBF000-G", "KYBF000-R"]);
    expect(product.details).toBeNull();
    expect(product.seo).toBeNull();
    expect((await api.products.listTags("fixture")).some((row) => row.tag === "fall")).toBe(true);

    expect(await api.products.setTags("fixture", "feeder-0", ["Holiday", "fall", "fall"])).toEqual(["fall", "holiday"]);
    const ledger = await readCsv(path.join(projectPath, PATHS.skuTags));
    expect(ledger.filter((row) => ["KYBF000-G", "KYBF000-R"].includes(String(row.sku))).map((row) => row.tags))
      .toEqual(["fall;holiday", "fall;holiday"]);
    const updatedView = (await readJsonl(path.join(projectPath, PATHS.productsView))).find((row) => row.handle === "feeder-0");
    expect(updatedView?.tags).toEqual(["fall", "holiday"]);
  }, 20_000);

  it("updates project config and invalidates the in-memory snapshot", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const first = await api.projects.get("fixture");
    const updated = await api.projects.updateConfig("fixture", { brand: { ...first.config.brand, tagline: "Built for birds" } });
    expect(updated.brand.tagline).toBe("Built for birds");
    expect((await api.projects.get("fixture")).config.brand.tagline).toBe("Built for birds");

    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as Record<string, unknown>;
    site.locale = "en-GB";
    await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`, "utf8");
    api.invalidate(projectPath);
    expect((await api.projects.get("fixture")).config.locale).toBe("en-GB");
  }, 30_000);

  it("writes a feed and refreshes the project summary without a missing-feed warning", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const first = await api.projects.get("fixture");
    const feedUrl = "https://shop.example.test/products.xml";

    const updated = await api.projects.updateConfig("fixture", {
      crawl: { ...first.config.crawl, feed_url: [feedUrl] },
    });
    expect(updated.crawl.feed_url).toEqual([feedUrl]);
    expect((await api.projects.get("fixture")).summary.warnings).toEqual([]);
    expect((await api.overview.get("fixture")).attention.some((item) => item.text === "尚未填写 GMC feed")).toBe(false);

    const written = JSON.parse(await readFile(path.join(projectPath, PATHS.site), "utf8")) as {
      crawl: { feed_url?: string | string[]; feed_urls?: unknown };
    };
    expect(written.crawl.feed_url).toEqual([feedUrl]);
    expect(written.crawl.feed_urls).toBeUndefined();
  }, 30_000);

  it("reads the legacy plural feed field and writes it back canonically", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as {
      crawl: Record<string, unknown>;
    };
    const feedUrl = "https://shop.example.test/legacy-products.xml";
    delete site.crawl.feed_url;
    site.crawl.feed_urls = [feedUrl];
    await writeFile(sitePath, JSON.stringify(site, null, 2) + "\n", "utf8");
    api.invalidate(projectPath);

    const loaded = await api.projects.get("fixture");
    expect(loaded.config.crawl.feed_url).toEqual([feedUrl]);
    expect(loaded.summary.warnings).toEqual([]);

    await api.projects.updateConfig("fixture", { brand: loaded.config.brand });
    const written = JSON.parse(await readFile(sitePath, "utf8")) as {
      crawl: { feed_url?: string | string[]; feed_urls?: unknown };
    };
    expect(written.crawl.feed_url).toEqual([feedUrl]);
    expect(written.crawl.feed_urls).toBeUndefined();
    expect((await api.projects.get("fixture")).summary.warnings).toEqual([]);
  }, 30_000);

  it("previews active feed SKUs and reports invalid grouping rules as configuration errors", async () => {
    const { projectPath } = await makeProject();
    await writeJsonl(path.join(projectPath, PATHS.skus), [
      { sku: "FAMILY-A-RED", status: "active" },
      { sku: "FAMILY-A-BLUE", status: "active" },
      { sku: "SINGLE-G", status: "active" },
      { sku: "REMOVED-A-RED", status: "removed" },
    ], { primaryKey: ["sku"] });
    const api = service(projectPath);

    await expect(api.sku.previewGrouping("fixture", { type: "separator", value: "-" })).resolves.toEqual({
      parents: 2,
      children: 3,
      samples: [
        { parent: "FAMILY-A", children: ["FAMILY-A-BLUE", "FAMILY-A-RED"] },
        { parent: "SINGLE", children: ["SINGLE-G"] },
      ],
      unmatched: 0,
    });
    await expect(api.sku.previewGrouping("fixture", { type: "regex", value: "[" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "SKU 分组规则无效：正则表达式语法无效。",
    });
  }, 30_000);

  it("serves the remaining core query namespaces and runs a dry-run views Job", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const [overview, seo, content, edmSummary, design, readme, categories, folders, schedule, runner] = await Promise.all([
      api.overview.get("fixture"),
      api.seo.summary("fixture"),
      api.content.summary("fixture"),
      api.edm.summary("fixture"),
      api.design.get("fixture"),
      api.readme.get("fixture"),
      api.categories.get("fixture"),
      api.folders.list("fixture"),
      api.schedule.get("fixture"),
      api.runner.get("fixture"),
    ]);

    expect(overview.agent_instruction).toContain("README.md");
    expect(seo.kpis.length).toBeGreaterThan(0);
    expect(content.kpis.length).toBeGreaterThan(0);
    expect(edmSummary.total).toBeGreaterThan(0);
    expect(design.tokens).not.toBeUndefined();
    expect(readme.folder_map.length).toBe(folders.length);
    expect(categories.mode).toBe("feed");
    expect(schedule.registered).toBe(false);
    expect(runner.this_device.device_id).toBe("test-device");
    expect((await api.seo.listPages("fixture", { page: 1, pageSize: 0 })).rows).toBeInstanceOf(Array);
    expect((await api.content.listBlog("fixture", { page: 1, pageSize: 0 })).rows).toBeInstanceOf(Array);
    expect((await api.edm.listImages("fixture", { page: 1, pageSize: 0 })).rows).toBeInstanceOf(Array);
    expect((await api.categories.preview("fixture", categories)).categories.length).toBeGreaterThan(0);
    const validation = await api.files.validate("fixture");
    expect(validation.summary.total).toBeGreaterThan(0);
    expect((await api.files.lastReport("fixture"))?.checked_at).toBe(validation.checked_at);

    const result = await api.runJob({ projectPath, job: "views", trigger: "manual", dryRun: true }, () => undefined);
    expect(result).toMatchObject({ job: "views", status: "ok", exitCode: 0 });
  }, 45_000);

  it("keeps warm 10,000-row inventory queries under 50 ms", async () => {
    const { projectPath } = await makeProject();
    const rows = Array.from({ length: 10_000 }, (_, index) => stockRow(`SKU-${String(index).padStart(5, "0")}`, `Product ${index}`, "in_stock"));
    await writeJsonl(path.join(projectPath, PATHS.skuStockView), rows as unknown as JsonRecord[], {
      primaryKey: ["sku"], fieldOrder: STOCK_FIELDS, floatFields: ["price", "online_rate_7d", "online_rate_30d"],
    });
    const api = service(projectPath);
    await api.inventory.listSkus("fixture", { page: 1, pageSize: 50 });

    const started = performance.now();
    const result = await api.inventory.listSkus("fixture", { page: 1, pageSize: 50, search: "product 99" });
    const elapsed = performance.now() - started;
    expect(result.rows.length).toBe(50);
    expect(elapsed).toBeLessThan(50);
  }, 60_000);
});
