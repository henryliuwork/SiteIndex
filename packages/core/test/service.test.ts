import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CSV_HEADERS, PATHS, type BlogPost, type Category, type ProductView, type SeoIssue, type SkuRecord, type SkuStockView, type StockStatus } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../src/service";
import { readCsv, writeCsv } from "../src/io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../src/io/jsonl";
import { withLock } from "../src/io/runner-lock";

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

async function installInterruptedDailyTransaction(
  projectPath: string,
  options: { afterIndexes?: readonly number[]; externalIndex?: number } = {},
): Promise<{ manifestPath: string; backupDirectory: string; targets: string[]; externalBytes?: Buffer }> {
  const paths = PATHS;
  const targets = [
    `${paths.eventsDir}/2026-10.jsonl`,
    paths.inventoryLatest,
    paths.skus,
    paths.dailySummary,
  ];
  const backupDirectory = path.join(projectPath, paths.jobLogsDir, "daily-output-transaction-backups");
  await mkdir(backupDirectory, { recursive: true });
  const files = [];
  for (const [index, target] of targets.entries()) {
    const targetPath = path.join(projectPath, target);
    const before = await readFile(targetPath);
    const after = Buffer.from(`synthetic after ${index}\n`);
    const backup = path.join(backupDirectory, `${index}.before`);
    const staged = path.join(backupDirectory, `${index}.after`);
    await writeFile(backup, before);
    await writeFile(staged, after);
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    files.push({
      target,
      backup: `${paths.jobLogsDir}/daily-output-transaction-backups/${index}.before`,
      staged: `${paths.jobLogsDir}/daily-output-transaction-backups/${index}.after`,
      before_hash: sha256(before),
      after_hash: sha256(after),
    });
    if (options.afterIndexes?.includes(index)) await writeFile(targetPath, after);
  }
  let externalBytes: Buffer | undefined;
  if (options.externalIndex !== undefined) {
    externalBytes = Buffer.from("synthetic external edit\n");
    await writeFile(path.join(projectPath, targets[options.externalIndex]!), externalBytes);
  }
  const manifestPath = path.join(projectPath, paths.jobLogsDir, "daily-output-transaction.json");
  await writeFile(manifestPath, `${JSON.stringify({ version: 2, files })}\n`);
  return { manifestPath, backupDirectory, targets, ...(externalBytes ? { externalBytes } : {}) };
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
    expect(inventory.timezone).toBe(detail.config.timezone);
    expect(inventory.trend.dates).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(legacy14DayInventory.trend).toEqual(inventory.trend);
    expect(inventory.category_rates.length).toBeGreaterThan(0);
    expect(inventory.category_source).toBe(detail.config.categories?.mode ?? "feed");
    expect(await api.inventory.dailyReport("fixture", "2026-10-21")).toContain("库存日报");
    expect(await api.inventory.dailyReport("fixture", "2026-10-18")).toBeNull();
  }, 30_000);

  it("reads the last committed inventory view without recovering or writing during an interrupted transaction", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const expected = await api.inventory.summary("fixture", 30);
    const paths = PATHS;
    const originalEvents = await readFile(path.join(projectPath, paths.eventsDir, "2026-10.jsonl"));
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0] });

    const read = await api.inventory.summary("fixture", 30);

    expect(read).toEqual(expected);
    expect(await readFile(path.join(projectPath, paths.eventsDir, "2026-10.jsonl"))).not.toEqual(originalEvents);
    await expect(readFile(transaction.manifestPath)).resolves.toBeTruthy();
    await expect(readFile(path.join(transaction.backupDirectory, "0.before"))).resolves.toBeTruthy();
  }, 30_000);

  it("fails closed on a JSON-null transaction journal without deleting recovery material", async () => {
    const { projectPath } = await makeProject();
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0] });
    await writeFile(transaction.manifestPath, "null\n");

    await expect(service(projectPath).projects.get("fixture")).rejects.toThrow("记录不完整");

    await expect(readFile(transaction.manifestPath)).resolves.toEqual(Buffer.from("null\n"));
    await expect(readFile(path.join(transaction.backupDirectory, "0.before"))).resolves.toBeTruthy();
    await expect(readFile(path.join(transaction.backupDirectory, "0.after"))).resolves.toBeTruthy();
  }, 30_000);

  it("recovers an interrupted daily transaction before categories.save mutates its protected SKU output", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });

    const result = await api.categories.save("fixture", { mode: "feed" });

    expect(result.uncategorized).toBe(0);
    expect(await readFile(transaction.manifestPath).catch(() => null)).toBeNull();
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).toContain('"sku":"KYBF000-G"');
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).not.toContain("synthetic after 2");
  }, 30_000);

  it("recovers an interrupted daily transaction before EDM image edits rebuild protected views", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });

    const result = await api.edm.setManualImage("fixture", "KYBF000-G", "https://images.example.test/demo.jpg");

    expect(result.sku).toBe("KYBF000-G");
    expect(await readFile(transaction.manifestPath).catch(() => null)).toBeNull();
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).toContain('"sku":"KYBF000-G"');
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).not.toContain("synthetic after 2");
    expect(await readFile(path.join(projectPath, PATHS.skuMedia), "utf8")).toContain("https://images.example.test/demo.jpg");
  }, 30_000);

  it("recovers an interrupted daily transaction before product tag mutations read SKU inputs", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const productRows = await readJsonl(path.join(projectPath, PATHS.productsView));
    const handle = String(productRows[0]?.handle ?? "");
    expect(handle).not.toBe("");
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });

    await api.products.setTags("fixture", handle, ["demo-review"]);

    expect(await readFile(transaction.manifestPath).catch(() => null)).toBeNull();
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).not.toContain("synthetic after 2");
    expect(await readFile(path.join(projectPath, PATHS.skuTags), "utf8")).toContain("demo-review");
  }, 30_000);

  it("recovers an interrupted daily transaction before product tag deletion", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const productRows = await readJsonl(path.join(projectPath, PATHS.productsView));
    const handle = String(productRows[0]?.handle ?? "");
    expect(handle).not.toBe("");
    await api.products.setTags("fixture", handle, ["demo-remove"]);
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });

    await api.products.deleteTag("fixture", "demo-remove");

    expect(await readFile(transaction.manifestPath).catch(() => null)).toBeNull();
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).not.toContain("synthetic after 2");
    expect(await readFile(path.join(projectPath, PATHS.skuTags), "utf8")).not.toContain("demo-remove");
  }, 30_000);

  it("rejects EDM index rendering while the project lock is held without recovering daily output", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });
    let signalHeld!: () => void;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const owner = withLock(projectPath, async () => {
      signalHeld();
      await release;
    }, { deviceId: "render-index-lock-holder", job: "synthetic-long-job", heartbeatMs: 60_000 });
    await held;

    try {
      await expect(api.edm.renderIndex("fixture")).rejects.toMatchObject({ code: "LOCKED" });
      await expect(readFile(transaction.manifestPath)).resolves.toBeTruthy();
      expect(await readFile(path.join(projectPath, transaction.targets[0]!), "utf8")).toBe("synthetic after 0\n");
      expect(await readFile(path.join(projectPath, transaction.targets[2]!), "utf8")).toBe("synthetic after 2\n");
    } finally {
      releaseHeld();
      await owner;
    }
  }, 30_000);

  it("recovers an interrupted daily transaction before returning a consistent EDM snapshot", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const expected = await api.edm.renderIndex("fixture");
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });
    const originalBytes = await Promise.all(transaction.targets.map((_, index) =>
      readFile(path.join(transaction.backupDirectory, `${index}.before`))));

    const rendered = await api.edm.renderIndex("fixture");

    expect(rendered).toEqual(expected);
    await expect(readFile(transaction.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    for (const [index, target] of transaction.targets.entries()) {
      expect(await readFile(path.join(projectPath, target))).toEqual(originalBytes[index]);
    }
  }, 30_000);

  it("serves query APIs while a runner holds the project job lock", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    let signalHeld!: () => void;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const owner = withLock(projectPath, async () => {
      signalHeld();
      await release;
    }, { deviceId: "holder", job: "synthetic-long-job", heartbeatMs: 60_000 });
    await held;
    try {
      const [project, overview, inventory, skuPage, runner, design, validation] = await Promise.race([
        Promise.all([
          api.projects.get("fixture"),
          api.overview.get("fixture"),
          api.inventory.summary("fixture", 30),
          api.inventory.listSkus("fixture", { page: 1, pageSize: 20 }),
          api.runner.get("fixture"),
          api.design.get("fixture"),
          api.files.validate("fixture"),
        ]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("query APIs waited for the project lock")), 2_000)),
      ]);
      expect(project.summary.id).toBe("fixture");
      expect(overview.kpis.some((kpi) => kpi.key === "products")).toBe(true);
      expect(inventory.as_of).toBe("2026-10-21");
      expect(skuPage.total).toBeGreaterThan(0);
      expect(runner.runner).toBeNull();
      expect(design).toBeTruthy();
      expect(validation.files.length).toBeGreaterThan(0);
    } finally {
      releaseHeld();
      await owner;
    }
  }, 10_000);

  it("serves read-only queries without creating a lock in a read-only logs directory", async () => {
    const { projectPath } = await makeProject();
    const lockPath = path.join(projectPath, PATHS.lock);
    const lockDirectory = path.dirname(lockPath);
    await chmod(lockDirectory, 0o555);
    try {
      const api = service(projectPath);
      expect((await api.projects.get("fixture")).summary.id).toBe("fixture");
      expect((await api.overview.get("fixture")).kpis.some((kpi) => kpi.key === "products")).toBe(true);
      expect((await api.inventory.summary("fixture", 30)).as_of).toBe("2026-10-21");
      expect(await api.design.get("fixture")).toBeTruthy();
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(lockDirectory, 0o755);
    }
  }, 10_000);

  it("validates the last committed files during recovery and serializes repair with recovery", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const baseline = await api.files.validate("fixture");
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0, 2] });

    const [report, design] = await Promise.all([api.files.validate("fixture"), api.design.get("fixture")]);

    const statusByPath = (checks: typeof report.files) => Object.fromEntries(checks
      .filter((file) => transaction.targets.includes(file.path))
      .map((file) => [file.path, file.status]));
    expect(statusByPath(report.files)).toEqual(statusByPath(baseline.files));
    expect(design).toBeTruthy();
    await expect(readFile(transaction.manifestPath)).resolves.toBeTruthy();

    await api.files.repair("fixture", PATHS.inventoryLatest, "autofix");

    await expect(readFile(transaction.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("fails closed before weekly reads when an interrupted daily output was externally changed", async () => {
    const { projectPath } = await makeProject();
    const transaction = await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0], externalIndex: 1 });
    const fetchSpy = vi.fn(async () => new Response("<urlset />", { headers: { "content-type": "application/xml" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await service(projectPath).runJob(
      { projectPath, job: "weekly", trigger: "manual", date: "2026-10-22" },
      () => undefined,
    );

    expect(result.status).toBe("failed");
    expect(result.errors?.[0]).toContain("被其他进程修改");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readFile(path.join(projectPath, transaction.targets[1]!))).toEqual(transaction.externalBytes);
    await expect(readFile(transaction.manifestPath)).resolves.toBeTruthy();
    await expect(readFile(path.join(transaction.backupDirectory, "0.before"))).resolves.toBeTruthy();
  }, 30_000);

  it("keeps init from continuing into weekly after daily leaves a conflicted transaction", async () => {
    const { projectPath } = await makeProject();
    const configPath = path.join(projectPath, PATHS.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as import("@siteindex/shared").SiteConfig;
    config.base_url = "https://shop.example.test";
    config.sitemaps = ["https://shop.example.test/sitemap.xml"];
    config.crawl.feed_url = "https://shop.example.test/feed.csv";
    config.crawl.rate_limit_ms = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const requested: string[] = [];
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requested.push(url.pathname);
      if (url.pathname === "/feed.csv") {
        await installInterruptedDailyTransaction(projectPath, { afterIndexes: [0], externalIndex: 1 });
        return new Response("<html><body>Login required</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("<urlset />", { headers: { "content-type": "application/xml" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await service(projectPath).runJob(
      { projectPath, job: "init", trigger: "manual", date: "2026-10-22" },
      () => undefined,
    );

    expect(result.status).toBe("partial");
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "daily", status: "failed", message: expect.stringContaining("网页而不是商品 feed") }),
      expect.objectContaining({ key: "weekly", status: "failed", message: expect.stringContaining("被其他进程修改") }),
    ]));
    expect(requested).toEqual(["/feed.csv"]);
    const targets = [
      `${PATHS.eventsDir}/2026-10.jsonl`,
      PATHS.inventoryLatest,
    ];
    expect(await readFile(path.join(projectPath, targets[0]!))).toEqual(Buffer.from("synthetic after 0\n"));
    expect(await readFile(path.join(projectPath, targets[1]!))).toEqual(Buffer.from("synthetic external edit\n"));
  }, 30_000);

  it("surfaces feed-anomaly events in the inventory summary without treating them as SEO issues", async () => {
    const { projectPath } = await makeProject();
    const eventPath = path.join(projectPath, PATHS.eventsDir, "2026-10.jsonl");
    const seoIssuesPath = path.join(projectPath, PATHS.seoIssues);
    const events = await readJsonl(eventPath);
    const seoIssuesBefore = await readJsonl(seoIssuesPath);
    await writeJsonl(eventPath, [...events, {
      date: "2026-10-21",
      sku: "DEMO-ANOMALY",
      type: "feed_anomaly",
      from: "feed_absent",
      to: "in_stock",
      category: "demo",
      title: "Demo item",
    }], "inventory_event");
    const api = service(projectPath);
    api.invalidate(projectPath);

    const summary = await api.inventory.summary("fixture", 30);

    expect(summary.today).toContainEqual(expect.objectContaining({
      type: "feed_anomaly",
      sku: "DEMO-ANOMALY",
      detail: "Feed 缺席，但页面仍显示有货。",
    }));
    expect(await readJsonl(seoIssuesPath)).toEqual(seoIssuesBefore);
  });

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

  it("groups product rows by configured parent SKU rules without changing persisted views", async () => {
    const { projectPath } = await makeProject();
    const fixture = JSON.parse(await readFile(path.resolve(process.cwd(), "fixtures/inputs/v030-products-parent-view.json"), "utf8")) as {
      rule: { type: "regex"; value: string };
      base_url: string;
      rows: { sku: string; handle: string; title: string; stock_status: StockStatus }[];
    };
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8"));
    site.sku_grouping = { enabled: true, rule: fixture.rule };
    await writeFile(sitePath, JSON.stringify(site));

    const skuRows: SkuRecord[] = fixture.rows.map((row, index) => ({
      sku: row.sku,
      product_id: row.sku,
      handle: row.handle,
      title: row.title,
      variant_title: null,
      url: `${fixture.base_url}/products/${row.handle}`,
      category: "demo-catalog",
      category_source: "feed",
      price: 10 + index,
      compare_at_price: null,
      currency: "USD",
      image_url: null,
      status: "active",
      first_seen: "2026-11-01",
      last_seen: "2026-11-05",
      updated_at: "2026-11-05",
    }));
    const stockRows = fixture.rows.map((row) => ({ ...stockRow(row.sku, row.title, row.stock_status), category: "demo-catalog" }));
    const products: ProductView[] = fixture.rows.map((row, index) => ({
      handle: row.handle,
      product_id: row.sku,
      title: row.title,
      url: `${fixture.base_url}/products/${row.handle}`,
      category: "demo-catalog",
      categories: ["demo-catalog"],
      price_min: 10 + index,
      price_max: 10 + index,
      compare_at_max: null,
      currency: "USD",
      on_sale: false,
      image_url: null,
      image_source: "none",
      feed_image_url: null,
      manual_image_url: null,
      variant_count: 1,
      skus: [row.sku],
      in_stock_variants: row.stock_status === "in_stock" ? 1 : 0,
      stock_status: row.stock_status,
      stock_since: "2026-11-01",
      tags: [],
      priority: null,
      exclude_edm: 0,
      last_featured: null,
      days_since_featured: null,
      first_seen: "2026-11-01",
      status: "active",
    }));
    await writeJsonl(path.join(projectPath, PATHS.skus), skuRows as unknown as JsonRecord[], { primaryKey: ["sku"] });
    await writeJsonl(path.join(projectPath, PATHS.skuStockView), stockRows as unknown as JsonRecord[], { primaryKey: ["sku"] });
    const productViewPath = path.join(projectPath, PATHS.productsView);
    await writeJsonl(productViewPath, products as unknown as JsonRecord[], { primaryKey: ["handle"] });
    const persistedBefore = await readFile(productViewPath);
    const api = service(projectPath);

    const parentRows = await api.products.list("fixture", {
      page: 1, pageSize: 0, filters: { parent_only: true },
    });
    expect(parentRows.total).toBe(6);
    expect(parentRows.rows.filter((row) => row.row_kind === "parent").map((row) => row.product_id)).toEqual([
      "DEMO001A", "DEMO002B",
    ]);
    expect(parentRows.rows.filter((row) => row.row_kind === "single").map((row) => row.product_id)).toEqual([
      "DEMO003C01", "DEMO003C02", "DEMO003C", "DEMO004D",
    ]);
    expect(parentRows.rows.find((row) => row.product_id === "DEMO001A")).toMatchObject({
      row_kind: "parent", parent_sku: null, variant_count: 3, in_stock_variants: 2, stock_status: "in_stock",
      skus: ["DEMO001A01", "DEMO001A02", "DEMO001A03"],
    });
    expect(parentRows.rows.find((row) => row.product_id === "DEMO002B")).toMatchObject({
      row_kind: "parent", variant_count: 2, in_stock_variants: 0, stock_status: "out_of_stock",
    });
    expect((await api.products.list("fixture", {
      page: 1, pageSize: 10, search: "DEMO001A02", filters: { parent_only: true },
    })).rows.map((row) => row.product_id)).toEqual(["DEMO001A"]);
    expect((await api.products.list("fixture", {
      page: 1, pageSize: 2, filters: { parent_only: true },
    })).total).toBe(6);

    const fullRows = await api.products.list("fixture", { page: 1, pageSize: 0 });
    expect(fullRows.total).toBe(products.length);
    for (const childSku of ["DEMO001A01", "DEMO001A02", "DEMO001A03", "DEMO002B01", "DEMO002B02"]) {
      expect(fullRows.rows.find((row) => row.skus.includes(childSku))).toMatchObject({
        row_kind: "child", parent_sku: childSku.startsWith("DEMO001A") ? "DEMO001A" : "DEMO002B",
        variant_count: null, in_stock_variants: null,
      });
    }
    expect(fullRows.rows.filter((row) => row.row_kind === "single").map((row) => row.product_id)).toEqual([
      "DEMO003C01", "DEMO003C02", "DEMO003C", "DEMO004D",
    ]);
    expect(await readFile(productViewPath)).toEqual(persistedBefore);

    // The fixture contains a real DEMO003C parent and two real children.
    site.sku_grouping.rule.parent_source = "feed";
    await writeFile(sitePath, JSON.stringify(site));
    const feedStocks = stockRows.map((row) => row.sku.startsWith("DEMO003C") && row.sku !== "DEMO003C"
      ? { ...row, parent_sku: "DEMO003C" } : row);
    await writeJsonl(path.join(projectPath, PATHS.skuStockView), feedStocks as unknown as JsonRecord[], { primaryKey: ["sku"] });
    api.invalidate(projectPath);
    const feedProducts = await api.products.list("fixture", { page: 1, pageSize: 0, filters: { parent_only: true } });
    const familyRow = feedProducts.rows.find((row) => row.product_id === "DEMO003C");
    expect(familyRow).toMatchObject({ row_kind: "parent", skus: ["DEMO003C", "DEMO003C01", "DEMO003C02"] });
    expect(feedProducts.rows.flatMap((row) => row.skus).filter((sku) => sku === "DEMO003C")).toHaveLength(1);
    const parentHandle = skuRows.find((row) => row.sku === "DEMO003C")!.handle;
    const childHandle = skuRows.find((row) => row.sku === "DEMO003C01")!.handle;
    for (const handle of [parentHandle, childHandle]) {
      const details = await api.products.get("fixture", handle);
      expect(details.variants.map((row) => row.sku)).toEqual(["DEMO003C", "DEMO003C01", "DEMO003C02"]);
    }
    const feedInventory = await api.inventory.listSkus("fixture", { page: 1, pageSize: 0, filters: { parent_only: true } });
    const parentStock = feedStocks.find((row) => row.sku === "DEMO003C")!;
    expect(feedInventory.rows.filter((row) => row.sku === "DEMO003C")).toEqual([
      expect.objectContaining({ stock_status: parentStock.stock_status, history_30d: parentStock.history_30d, is_parent: true }),
    ]);
    expect(await readFile(productViewPath)).toEqual(persistedBefore);

    site.sku_grouping.enabled = false;
    await writeFile(sitePath, JSON.stringify(site));
    api.invalidate(projectPath);
    const disabled = await api.products.list("fixture", {
      page: 1, pageSize: 0, filters: { parent_only: true },
    });
    expect(disabled.total).toBe(products.length);
    expect(disabled.rows.every((row) => row.row_kind === undefined)).toBe(true);
  }, 20_000);

  it("builds deterministic parent display rows without persisting or counting them as stock", async () => {
    const { projectPath } = await makeProject();
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8"));
    site.sku_grouping = { enabled: true, rule: { type: "regex", value: "^(.+?)\\d{1,3}$" } };
    await writeFile(sitePath, JSON.stringify(site));
    const skuStockPath = path.join(projectPath, PATHS.skuStockView);
    const rows = [
      { ...stockRow("DEMO001A01", "Demo parent A", "in_stock", "z-category"), parent_sku: "DEMO001A", price: 30,
        history_30d: "i".repeat(30) },
      { ...stockRow("DEMO001A02", "Demo parent A", "out_of_stock", "a-category"), parent_sku: "DEMO001A", price: 20,
        price_history: [{ date: "2026-10-20", price: 20 }], history_30d: "o".repeat(30) },
      { ...stockRow("DEMO002B01", "Demo parent B", "out_of_stock"), parent_sku: "DEMO002B", history_30d: "o".repeat(30) },
      { ...stockRow("DEMO002B02", "Demo parent B", "out_of_stock"), parent_sku: "DEMO002B", history_30d: "o".repeat(30) },
      { ...stockRow("DEMO003C01", "Demo parent C", "unknown"), parent_sku: "DEMO003C", history_30d: "u".repeat(30) },
      { ...stockRow("DEMO003C02", "Demo parent C", "preorder"), parent_sku: "DEMO003C", history_30d: "p".repeat(30) },
      stockRow("INDEPENDENT", "Independent", "in_stock"),
    ];
    await writeJsonl(skuStockPath, rows.map((row) => ({ ...row })), { primaryKey: ["sku"], fieldOrder: STOCK_FIELDS });
    const originalFile = await readFile(skuStockPath);
    const api = service(projectPath);
    const query = { page: 1, pageSize: 0, filters: { parent_only: true } } as const;
    const parents = await api.inventory.listSkus("fixture", query);
    expect(parents.total).toBe(4);
    expect(parents.rows.map((row) => row.sku)).toEqual(["DEMO001A", "DEMO002B", "DEMO003C", "INDEPENDENT"]);
    expect(parents.rows[0]).toMatchObject({ is_parent: true, children_count: 2, in_stock_children_count: 1,
      stock_status: "in_stock", category: "a-category", price: 20, history_30d: "i".repeat(30),
      online_rate_7d: 1, online_rate_30d: 1, changes_30d: 0, last_change: null, last_change_at: null });
    expect(parents.rows[1]).toMatchObject({ stock_status: "out_of_stock", children_count: 2, in_stock_children_count: 0 });
    expect(parents.rows[2]).toMatchObject({ stock_status: "preorder", children_count: 2 });
    expect(parents.rows[3]?.is_parent).toBeUndefined();
    expect((await api.inventory.listSkus("fixture", { ...query, pageSize: 2, page: 2 })).rows.map((row) => row.sku))
      .toEqual(["DEMO003C", "INDEPENDENT"]);
    expect((await api.inventory.listSkus("fixture", { ...query, search: "DEMO001A02" })).rows.map((row) => row.sku))
      .toEqual(["DEMO001A"]);
    expect((await api.inventory.listSkus("fixture", { ...query, filters: { parent_only: true, price_changed_within: 30 } })).rows.map((row) => row.sku))
      .toEqual(["DEMO001A"]);
    expect((await api.inventory.listSkus("fixture", { page: 1, pageSize: 0 })).rows.map((row) => row.sku))
      .toEqual(rows.map((row) => row.sku).sort());
    expect(await readFile(skuStockPath)).toEqual(originalFile);

    site.sku_grouping.enabled = false;
    await writeFile(sitePath, JSON.stringify(site));
    api.invalidate(projectPath);
    expect((await api.inventory.listSkus("fixture", query)).total).toBe(rows.length);
  }, 20_000);

  it("filters SKUs by real price changes within 30, 60, 90 and all days", async () => {
    const { projectPath } = await makeProject();
    const asOf = Date.UTC(2026, 9, 21);
    const dateBefore = (days: number) => new Date(asOf - days * 86_400_000).toISOString().slice(0, 10);
    const rows = [
      { ...stockRow("SKU-20", "Changed 20 days ago", "in_stock"), price_history: [{ date: dateBefore(20), price: 10 }] },
      { ...stockRow("SKU-30", "Changed at 30-day boundary", "in_stock"), price_history: [{ date: dateBefore(30), price: 10.5 }] },
      { ...stockRow("SKU-45", "Changed 45 days ago", "in_stock"), price_history: [{ date: dateBefore(45), price: 11 }] },
      { ...stockRow("SKU-75", "Changed 75 days ago", "in_stock"), price_history: [{ date: dateBefore(75), price: 12 }] },
      { ...stockRow("SKU-FUTURE", "Future event", "in_stock"), price_history: [{ date: "2026-10-22", price: 13 }] },
      stockRow("SKU-BASELINE", "Current price only", "in_stock"),
    ];
    await writeJsonl(path.join(projectPath, PATHS.skuStockView), rows as unknown as JsonRecord[], {
      primaryKey: ["sku"], fieldOrder: STOCK_FIELDS, floatFields: ["price", "online_rate_7d", "online_rate_30d"],
    });
    const api = service(projectPath);
    const matchingSkus = async (range: 30 | 60 | 90 | "all") => (await api.inventory.listSkus("fixture", {
      page: 1, pageSize: 20, filters: { price_changed_within: range },
    })).rows.map((row) => row.sku).sort();

    expect(await matchingSkus(30)).toEqual(["SKU-20", "SKU-30"]);
    expect(await matchingSkus(60)).toEqual(["SKU-20", "SKU-30", "SKU-45"]);
    expect(await matchingSkus(90)).toEqual(["SKU-20", "SKU-30", "SKU-45", "SKU-75"]);
    expect(await matchingSkus("all")).toEqual(["SKU-20", "SKU-30", "SKU-45", "SKU-75"]);
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

  it("refreshes the snapshot after an external writer updates the blog index", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const blogIndexPath = path.join(projectPath, PATHS.blogIndex);
    const existingRows = await readJsonl(blogIndexPath);
    const initial = await api.content.summary("fixture");
    expect(initial.kpis.find((item) => item.key === "blogs")?.value).toBe(String(existingRows.length));

    const addedRow = existingRows[0]
      ? { ...existingRows[0], url: "https://shop.example.test/blog/external-writer", slug: "external-writer" }
      : { url: "https://shop.example.test/blog/external-writer", slug: "external-writer", title: "External writer fixture" };
    const replacement = [...existingRows, addedRow].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(blogIndexPath, replacement, "utf8");

    const refreshed = await api.content.summary("fixture");
    expect(refreshed.kpis.find((item) => item.key === "blogs")?.value).toBe(String(existingRows.length + 1));
  }, 30_000);

  it("counts blog issues with the same Article schema and link rules as listBlog", async () => {
    const { projectPath } = await makeProject();
    const blog = (slug: string, linksInternal: string[], linksProducts: string[], oos: string[] = []): BlogPost => ({
      url: `https://shop.example.test/blog/${slug}`, slug, title: slug,
      published_at: "2026-10-20", updated_at: null, category: null, author: null, tags: [],
      meta_description: null, word_count: 100, links_internal: linksInternal,
      links_products: linksProducts, linked_out_of_stock: oos, last_crawled: "2026-10-21",
    });
    const blogs = [
      blog("empty", [], []),
      blog("product-link", [], ["DEMO001A"], ["DEMO001A"]),
      blog("internal-link", ["https://shop.example.test/page"], []),
      blog("article", ["https://shop.example.test/other"], []),
    ];
    await writeJsonl(path.join(projectPath, PATHS.blogIndex), blogs.map((row) => ({ ...row })), { primaryKey: ["url"] });
    await writeJsonl(path.join(projectPath, PATHS.seoPages), [
      { url: blogs[1]!.url, schema_types: ["Article"] },
      { url: blogs[2]!.url, schema_types: ["FAQPage"] },
      { url: blogs[3]!.url, schema_types: ["https://schema.org/BlogPosting"] },
    ], { primaryKey: ["url"] });
    const api = service(projectPath);
    const summary = await api.content.summary("fixture");
    const kpis = new Map(summary.kpis.map((item) => [item.key, item.value]));
    expect(kpis.get("blogs")).toBe("4");
    for (const [issue, expected] of [["no_schema", 2], ["no_links", 1], ["links_oos", 1]] as const) {
      expect(kpis.get(issue)).toBe(String(expected));
      expect((await api.content.listBlog("fixture", { page: 1, pageSize: 0, filters: { issue } })).total).toBe(expected);
    }
  }, 20_000);

  it("builds project cards from summary files only and refreshes after an external blog write", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const blogIndexPath = path.join(projectPath, PATHS.blogIndex);
    const blogRows = await readJsonl(blogIndexPath);
    const seoIssueRows = await readJsonl(path.join(projectPath, PATHS.seoIssues));

    const seoPagesPath = path.join(projectPath, PATHS.seoPages);
    await mkdir(path.dirname(seoPagesPath), { recursive: true });
    await writeFile(seoPagesPath, "not valid JSONL\n", "utf8");
    const initial = await api.projects.get("fixture");
    expect(initial.summary.blog_count).toBe(blogRows.length);
    expect(initial.summary.attention).toBe(seoIssueRows.filter((row) => row.status === "open").length);

    const updatedBlogIndex = [...blogRows, { ...blogRows[0], slug: "external-summary-refresh" }]
      .map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(blogIndexPath, updatedBlogIndex, "utf8");

    expect((await api.projects.get("fixture")).summary.blog_count).toBe(blogRows.length + 1);
  }, 30_000);

  it("reads schedule configuration without loading unrelated index files", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const seoPagesPath = path.join(projectPath, PATHS.seoPages);
    await mkdir(path.dirname(seoPagesPath), { recursive: true });
    await writeFile(seoPagesPath, "not valid JSONL\n", "utf8");

    await expect(api.schedule.get("fixture")).resolves.toMatchObject({
      config: { daily: { enabled: true } },
      registered: false,
    });
  }, 30_000);

  it("groups overview SEO attention by rule and links to the in-app filtered list", async () => {
    const { projectPath } = await makeProject();
    const makeIssue = (rule: SeoIssue["rule"], status: SeoIssue["status"], index: number): SeoIssue => ({
      url: `https://shop.example.test/page-${index}`,
      rule,
      severity: "mid",
      detail: "虚构问题",
      status,
      first_seen: "2026-10-20",
      last_seen: "2026-10-21",
    });
    const issues = [
      makeIssue("desc_duplicate", "open", 1), makeIssue("desc_duplicate", "open", 2),
      makeIssue("http_4xx", "open", 3), makeIssue("title_missing", "open", 4),
      makeIssue("schema_missing", "open", 5), makeIssue("desc_missing", "open", 6),
      makeIssue("orphan", "open", 7), makeIssue("title_duplicate", "fixed", 8),
    ];
    await writeJsonl(path.join(projectPath, PATHS.seoIssues), issues.map((issue) => ({ ...issue })), "seo_issue");
    const overview = await service(projectPath).overview.get("fixture");
    const seoAttention = overview.attention.filter((item) => item.link_label === "查看 SEO 问题");
    expect(seoAttention).toHaveLength(5);
    expect(seoAttention[0]).toMatchObject({ text: "页面 4xx：1 个页面", link: "/p/fixture/seo?rule=http_4xx&status=open" });
    expect(seoAttention.find((item) => item.text === "Description 重复：2 个页面"))
      .toMatchObject({ link: "/p/fixture/seo?rule=desc_duplicate&status=open" });
    expect(seoAttention.some((item) => item.text === "Meta description 缺失：1 个页面")).toBe(true);
    expect(seoAttention.every((item) => item.link.startsWith("/p/fixture/seo?"))).toBe(true);
    expect(seoAttention.some((item) => item.text.includes("Title 重复"))).toBe(false);
  }, 20_000);

  it("updates SEO issue statuses, persists per-page ignores, and counts only open issues", async () => {
    const { projectPath } = await makeProject();
    const makeIssue = (url: string, rule: SeoIssue["rule"], status: SeoIssue["status"]): SeoIssue => ({
      url: `https://shop.example.test/${url}`,
      rule,
      severity: "mid",
      detail: "虚构 SEO 问题",
      status,
      first_seen: "2026-11-01",
      last_seen: "2026-11-01",
    });
    await writeJsonl(path.join(projectPath, PATHS.seoIssues), [
      makeIssue("page-a", "desc_missing", "open"),
      makeIssue("page-b", "title_missing", "open"),
      makeIssue("page-c", "desc_missing", "open"),
    ].map((row) => ({ ...row })), "seo_issue");
    const api = service(projectPath);
    const urlA = "https://shop.example.test/page-a";
    const urlC = "https://shop.example.test/page-c";

    await expect(api.seo.setIssueStatus("fixture", {
      targets: [{ url: urlA, rule: "desc_missing" }, { url: urlC, rule: "desc_missing" }],
      status: "ignored",
    })).resolves.toEqual({ updated: 2 });
    await expect(api.seo.setIssueStatus("fixture", {
      targets: [{ url: urlC, rule: "desc_missing" }],
      status: "fixed",
    })).resolves.toEqual({ updated: 1 });

    const savedIssues = await readJsonl(path.join(projectPath, PATHS.seoIssues));
    expect(savedIssues.find((row) => row.url === urlA)).toMatchObject({ status: "ignored" });
    expect(savedIssues.find((row) => row.url === urlC)).toMatchObject({ status: "fixed" });
    const config = JSON.parse(await readFile(path.join(projectPath, PATHS.site), "utf8")) as {
      seo?: { ignore_rules?: { url?: string; rule: string }[] };
    };
    expect(config.seo?.ignore_rules).toContainEqual({ url: urlA, rule: "desc_missing" });

    const project = await api.projects.get("fixture");
    expect(project.summary.attention).toBe(1);
    const overviewSeo = (await api.overview.get("fixture")).attention.filter((item) => item.link_label === "查看 SEO 问题");
    expect(overviewSeo).toHaveLength(1);
    expect(overviewSeo[0]?.link).toContain("rule=title_missing&status=open");
    expect((await api.seo.listIssues("fixture", { page: 1, pageSize: 0, filters: { status: "open" } })).total).toBe(1);

    await expect(api.seo.setIssueStatus("fixture", { targets: [{ url: urlA, rule: "desc_missing" }], status: "open" }))
      .resolves.toEqual({ updated: 1 });
    const reopenedConfig = JSON.parse(await readFile(path.join(projectPath, PATHS.site), "utf8")) as {
      seo?: { ignore_rules?: { url?: string; rule: string }[] };
    };
    expect(reopenedConfig.seo?.ignore_rules).not.toContainEqual({ url: urlA, rule: "desc_missing" });
    expect((await api.projects.get("fixture")).summary.attention).toBe(2);
  }, 30_000);

  it("toggles a global SEO rule ignore while preserving specific page ignores and fixed history", async () => {
    const { projectPath } = await makeProject();
    const makeIssue = (slug: string, rule: SeoIssue["rule"], status: SeoIssue["status"]): SeoIssue => ({
      url: `https://shop.example.test/${slug}`,
      rule,
      severity: "mid",
      detail: "虚构 SEO 问题",
      status,
      first_seen: "2026-11-01",
      last_seen: "2026-11-01",
    });
    const scopedUrl = "https://shop.example.test/scoped";
    await writeJsonl(path.join(projectPath, PATHS.seoIssues), [
      makeIssue("global-one", "desc_missing", "open"),
      makeIssue("scoped", "desc_missing", "open"),
      makeIssue("fixed-history", "desc_missing", "fixed"),
      makeIssue("other-rule", "title_missing", "open"),
    ].map((row) => ({ ...row })), "seo_issue");
    const configPath = path.join(projectPath, PATHS.site);
    const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      seo?: Record<string, unknown>;
    };
    rawConfig.seo = { ...rawConfig.seo, ignore_rules: [{ url: scopedUrl, rule: "desc_missing" }] };
    await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");

    const api = service(projectPath);
    await expect(api.seo.setRuleIgnored("fixture", "desc_missing", true)).resolves.toEqual({ updated: 2 });
    let savedIssues = await readJsonl(path.join(projectPath, PATHS.seoIssues));
    expect(savedIssues.find((row) => row.url === "https://shop.example.test/global-one")).toMatchObject({ status: "ignored" });
    expect(savedIssues.find((row) => row.url === scopedUrl)).toMatchObject({ status: "ignored" });
    expect(savedIssues.find((row) => row.url === "https://shop.example.test/fixed-history")).toMatchObject({ status: "fixed" });
    expect(savedIssues.find((row) => row.url === "https://shop.example.test/other-rule")).toMatchObject({ status: "open" });

    const ignoredConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      seo?: { ignore_rules?: { url?: string; rule: string }[] };
    };
    expect(ignoredConfig.seo?.ignore_rules).toContainEqual({ rule: "desc_missing" });
    expect(ignoredConfig.seo?.ignore_rules).toContainEqual({ url: scopedUrl, rule: "desc_missing" });
    const validation = await api.files.validate("fixture", PATHS.site);
    expect(validation.files.find((file) => file.path === PATHS.site)?.status).toBe("ok");

    await expect(api.seo.setRuleIgnored("fixture", "desc_missing", false)).resolves.toEqual({ updated: 1 });
    savedIssues = await readJsonl(path.join(projectPath, PATHS.seoIssues));
    expect(savedIssues.find((row) => row.url === "https://shop.example.test/global-one")).toMatchObject({ status: "open" });
    expect(savedIssues.find((row) => row.url === scopedUrl)).toMatchObject({ status: "ignored" });
    expect(savedIssues.find((row) => row.url === "https://shop.example.test/fixed-history")).toMatchObject({ status: "fixed" });
    const unignoredConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      seo?: { ignore_rules?: { url?: string; rule: string }[] };
    };
    expect(unignoredConfig.seo?.ignore_rules).not.toContainEqual({ rule: "desc_missing" });
    expect(unignoredConfig.seo?.ignore_rules).toContainEqual({ url: scopedUrl, rule: "desc_missing" });
  }, 30_000);

  it("keeps ignored SEO issues across weekly and reopens fixed issues when the finding remains", async () => {
    const { projectPath } = await makeProject();
    const base = "https://shop.example.test";
    const configPath = path.join(projectPath, PATHS.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as import("@siteindex/shared").SiteConfig;
    config.domain = "shop.example.test";
    config.base_url = base;
    config.sitemaps = [`${base}/sitemap.xml`];
    config.crawl.feed_url = [];
    config.crawl.rate_limit_ms = 0;
    config.crawl.max_pages = 10;
    config.categories = { mode: "url_rule", url_pattern: "/collections/{slug}" };
    config.seo = { ...config.seo, ignore_rules: [] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/sitemap.xml") {
        return new Response(`<urlset><url><loc>${base}/</loc></url><url><loc>${base}/collections/fixture</loc></url></urlset>`, {
          headers: { "content-type": "application/xml" },
        });
      }
      const body = url.pathname === "/"
        ? '<html><head><title>Fixture home</title></head><body><main><h1>Fixture home</h1><a href="/collections/fixture">Fixture collection</a></main></body></html>'
        : '<html><head><title>Fixture collection</title></head><body><main><h1>Fixture collection</h1><p>Fictional collection text.</p></main></body></html>';
      return new Response(body, { headers: { "content-type": "text/html" } });
    }));
    const api = service(projectPath);
    const target = { url: `${base}/`, rule: "desc_missing" as const };

    const initialWeekly = await api.runJob({ projectPath, job: "weekly", trigger: "manual", date: "2026-11-01" }, () => undefined);
    expect(initialWeekly.status).not.toBe("failed");
    let issue = (await readJsonl(path.join(projectPath, PATHS.seoIssues))).find((row) => row.url === target.url && row.rule === target.rule);
    expect(issue).toMatchObject({ status: "open" });

    await api.seo.setIssueStatus("fixture", { targets: [target], status: "ignored" });
    await api.runJob({ projectPath, job: "weekly", trigger: "manual", date: "2026-11-02" }, () => undefined);
    issue = (await readJsonl(path.join(projectPath, PATHS.seoIssues))).find((row) => row.url === target.url && row.rule === target.rule);
    expect(issue).toMatchObject({ status: "ignored" });

    await api.seo.setIssueStatus("fixture", { targets: [target], status: "fixed" });
    await api.runJob({ projectPath, job: "weekly", trigger: "manual", date: "2026-11-03" }, () => undefined);
    issue = (await readJsonl(path.join(projectPath, PATHS.seoIssues))).find((row) => row.url === target.url && row.rule === target.rule);
    expect(issue).toMatchObject({ status: "open" });

    await api.seo.setRuleIgnored("fixture", "desc_missing", true);
    await api.runJob({ projectPath, job: "weekly", trigger: "manual", date: "2026-11-04" }, () => undefined);
    const globallyIgnored = await readJsonl(path.join(projectPath, PATHS.seoIssues));
    issue = globallyIgnored.find((row) => row.url === target.url && row.rule === target.rule);
    expect(issue).toMatchObject({ status: "ignored" });
    expect(globallyIgnored.find((row) => row.url === `${base}/collections/fixture` && row.rule === "desc_missing"))
      .toMatchObject({ status: "ignored" });
    await api.seo.setRuleIgnored("fixture", "desc_missing", false);
    const globallyReopened = await readJsonl(path.join(projectPath, PATHS.seoIssues));
    issue = globallyReopened.find((row) => row.url === target.url && row.rule === target.rule);
    expect(issue).toMatchObject({ status: "open" });
    expect(globallyReopened.find((row) => row.url === `${base}/collections/fixture` && row.rule === "desc_missing"))
      .toMatchObject({ status: "open" });
  }, 45_000);

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

  it("passes SKU grouping collisions through the Core service preview", async () => {
    const { projectPath } = await makeProject();
    await writeJsonl(path.join(projectPath, PATHS.skus), [
      { sku: "DEMO001A", status: "active" },
      { sku: "DEMO001A01", status: "active" },
      { sku: "DEMO001A02", status: "active" },
    ], { primaryKey: ["sku"] });
    const api = service(projectPath);

    await expect(api.sku.previewGrouping("fixture", { type: "regex", value: "^(.+?)\\d{1,3}$" })).resolves.toEqual({
      parents: 0,
      children: 0,
      samples: [],
      unmatched: 3,
      collisions: [{ parent: "DEMO001A", children: ["DEMO001A01", "DEMO001A02"] }],
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

  it("counts legacy SEO rules and combines rule, severity, and status filters", async () => {
    const { projectPath } = await makeProject();
    const api = service(projectPath);
    const issues: SeoIssue[] = [
      { url: "https://shop.example.test/short", rule: "title_too_short", severity: "low", detail: "fixture", status: "open", first_seen: "2026-10-29", last_seen: "2026-10-30" },
      { url: "https://shop.example.test/lang-open", rule: "hreflang_invalid", severity: "mid", detail: "fixture", status: "open", first_seen: "2026-10-29", last_seen: "2026-10-30" },
      { url: "https://shop.example.test/lang-ignored", rule: "hreflang_invalid", severity: "mid", detail: "fixture", status: "ignored", first_seen: "2026-10-29", last_seen: "2026-10-30" },
      { url: "https://shop.example.test/long-url", rule: "url_too_long", severity: "low", detail: "fixture", status: "fixed", first_seen: "2026-10-29", last_seen: "2026-10-30" },
      { url: "https://shop.example.test/legacy-title", rule: "title_length", severity: "low", detail: "legacy fixture", status: "fixed", first_seen: "2026-10-29", last_seen: "2026-10-30" },
      { url: "https://shop.example.test/legacy-description", rule: "desc_length", severity: "low", detail: "legacy fixture", status: "fixed", first_seen: "2026-10-29", last_seen: "2026-10-30" },
    ];
    await writeJsonl(path.join(projectPath, PATHS.seoIssues), issues.map((issue) => ({ ...issue })), "seo_issue");
    api.invalidate(projectPath);

    const summary = await api.seo.summary("fixture");
    const counts = new Map(summary.issue_counts?.map((item) => [item.rule, item]) ?? []);
    expect(counts.size).toBe(26);
    expect(counts.get("title_too_short")).toMatchObject({ label: "Title 过短", severity: "low", count: 1 });
    expect(counts.get("hreflang_invalid")).toMatchObject({ label: "hreflang 异常", severity: "mid", count: 2 });
    expect(counts.get("url_too_long")).toMatchObject({ label: "URL 过长", severity: "low", count: 1 });
    expect(counts.get("title_length")).toMatchObject({ label: "Title 长度异常", count: 1 });
    expect(counts.get("desc_length")).toMatchObject({ label: "Description 长度异常", count: 1 });
    expect(counts.get("http_4xx")).toMatchObject({ count: 0 });

    const selected = await api.seo.listIssues("fixture", {
      page: 1, pageSize: 10, filters: { rules: ["hreflang_invalid"] },
    });
    expect(selected.total).toBe(2);
    expect(selected.rows.every((issue) => issue.rule === "hreflang_invalid")).toBe(true);

    const combined = await api.seo.listIssues("fixture", {
      page: 1, pageSize: 10, filters: { rules: ["hreflang_invalid", "url_too_long"], severity: "mid", status: "open" },
    });
    expect(combined.total).toBe(1);
    expect(combined.rows[0]?.url).toBe("https://shop.example.test/lang-open");
  });

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
