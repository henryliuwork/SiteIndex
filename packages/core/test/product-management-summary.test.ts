import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CSV_HEADERS, PATHS, type InventoryEvent, type InventoryLatest, type ProductView,
  type SkuRecord, type SkuStockFilters, type SkuStockView, type StockStatus } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { writeCsv } from "../src/io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../src/io/jsonl";
import { createCoreService } from "../src/service";

const AS_OF = "2026-11-09";
const TEMP_DIRS: string[] = [];
const STOCKS: { sku: string; status: StockStatus; since: string; parent?: string }[] = [
  { sku: "DEMO-A", status: "out_of_stock", since: "2026-11-01" },
  { sku: "DEMO-A01", status: "in_stock", since: AS_OF, parent: "DEMO-A" },
  { sku: "DEMO-A02", status: "out_of_stock", since: AS_OF, parent: "DEMO-A" },
  { sku: "DEMO-B", status: "in_stock", since: "2026-11-01" },
  { sku: "DEMO-B01", status: "out_of_stock", since: "2026-11-03", parent: "DEMO-B" },
  { sku: "DEMO-B02", status: "out_of_stock", since: "2026-11-02", parent: "DEMO-B" },
  { sku: "DEMO-C", status: "out_of_stock", since: "2026-11-04" },
  { sku: "DEMO-D", status: "in_stock", since: AS_OF },
  { sku: "DEMO-E", status: "out_of_stock", since: "2026-11-08" },
];
const CHANGES: Pick<InventoryEvent, "date" | "sku" | "type" | "from" | "to">[] = [
  { date: AS_OF, sku: "DEMO-A01", type: "stock_change", from: "out_of_stock", to: "in_stock" },
  { date: AS_OF, sku: "DEMO-A02", type: "stock_change", from: "in_stock", to: "out_of_stock" },
  { date: "2026-11-03", sku: "DEMO-B01", type: "stock_change", from: "in_stock", to: "out_of_stock" },
  { date: "2026-11-02", sku: "DEMO-B02", type: "stock_change", from: "in_stock", to: "out_of_stock" },
  { date: AS_OF, sku: "DEMO-B01", type: "price_change", from: 10, to: 11 },
  { date: "2026-11-04", sku: "DEMO-C", type: "stock_change", from: "in_stock", to: "out_of_stock" },
  { date: "2026-10-25", sku: "DEMO-D", type: "stock_change", from: "in_stock", to: "out_of_stock" },
  { date: AS_OF, sku: "DEMO-D", type: "stock_change", from: "out_of_stock", to: "in_stock" },
  { date: "2026-10-25", sku: "DEMO-E", type: "stock_change", from: "in_stock", to: "preorder" },
  { date: "2026-11-08", sku: "DEMO-E", type: "stock_change", from: "preorder", to: "out_of_stock" },
];

async function syntheticProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-product-summary-"));
  TEMP_DIRS.push(root);
  const project = path.join(root, "project");
  await cp(path.resolve(process.cwd(), "fixtures/expected/project"), project, { recursive: true });
  const configPath = path.join(project, PATHS.site);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.sku_grouping = { enabled: true,
    rule: { type: "regex", value: "^(.+?)\\d{2}$", parent_source: "feed" } };
  await writeFile(configPath, `${JSON.stringify(config)}\n`);

  const records: SkuRecord[] = STOCKS.map(({ sku }) => ({
    sku, product_id: sku, handle: sku.toLowerCase(), title: sku, variant_title: null,
    url: `https://example.test/products/${sku.toLowerCase()}`, category: "demo", category_source: "feed",
    price: 10, compare_at_price: null, currency: "USD", image_url: null,
    status: "active", first_seen: "2026-10-01", last_seen: AS_OF, updated_at: AS_OF,
  }));
  const latest: InventoryLatest[] = STOCKS.map(({ sku, status, since }) => ({
    sku, stock_status: status, since, qty: null, checked_at: `${AS_OF}T12:00:00.000Z`,
  }));
  const stock: SkuStockView[] = STOCKS.map(({ sku, status, since, parent }) => ({
    sku, title: sku, variant_title: null, category: "demo", price: 10, stock_status: status,
    since, days_in_status: 1, online_rate_7d: null, online_rate_30d: null,
    history_30d: "u".repeat(30), changes_30d: 0, last_change: null, last_change_at: null,
    ...(parent ? { parent_sku: parent } : {}),
  }));
  const template = (await readJsonl(path.join(project, PATHS.productsView)))[0] as unknown as ProductView;
  const products: ProductView[] = STOCKS.map(({ sku, status }) => ({
    ...template, handle: sku.toLowerCase(), product_id: sku, title: sku,
    url: `https://example.test/products/${sku.toLowerCase()}`, skus: [sku],
    variant_count: 1, in_stock_variants: status === "in_stock" ? 1 : 0, stock_status: status,
  }));
  await Promise.all([
    writeJsonl(path.join(project, PATHS.skus), records as unknown as JsonRecord[], { primaryKey: ["sku"] }),
    writeJsonl(path.join(project, PATHS.inventoryLatest), latest as unknown as JsonRecord[], { primaryKey: ["sku"] }),
    writeJsonl(path.join(project, PATHS.skuStockView), stock as unknown as JsonRecord[], { primaryKey: ["sku"] }),
    writeJsonl(path.join(project, PATHS.productsView), products as unknown as JsonRecord[], { primaryKey: ["handle"] }),
    writeCsv(path.join(project, PATHS.dailySummary), [
      { date: AS_OF, category: "_all", total: 9, in_stock: 3, out_of_stock: 6, preorder: 0, unknown: 0 },
    ], CSV_HEADERS.dailySummary, ["date", "category"]),
  ]);
  const events = CHANGES.map((event) => ({ ...event, category: "demo", title: event.sku }));
  for (const month of ["2026-10", "2026-11"]) {
    await writeJsonl(path.join(project, PATHS.eventsDir, `${month}.jsonl`),
      events.filter((event) => event.date.startsWith(month)) as unknown as JsonRecord[],
      { primaryKey: ["date", "sku", "type"] });
  }
  return { project, api: createCoreService({ resolveProject: () => project,
    deviceId: "demo-device", cacheDir: path.join(root, "cache") }) };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("product management default-row summary", () => {
  it("counts children, deduplicates daily changes, and matches every summary filter to the visible rows", async () => {
    const { project, api } = await syntheticProject();
    const before = await readFile(path.join(project, PATHS.skuStockView));
    const summary = (await api.inventory.summary("fixture")).product_management;
    expect(summary).toEqual({ as_of: AS_OF, total_rows: 5, in_stock_rows: 2, online_rate: 0.4,
      changed_rows: 2, out_of_stock_7d_rows: 1, fluctuating_30d_rows: 1 });
    const rows = await api.inventory.listSkus("fixture", { page: 1, pageSize: 0, filters: { parent_only: true } });
    expect(rows.rows.map((row) => [row.sku, row.stock_status])).toEqual([
      ["DEMO-A", "in_stock"], ["DEMO-B", "out_of_stock"],
      ["DEMO-C", "out_of_stock"], ["DEMO-D", "in_stock"], ["DEMO-E", "out_of_stock"],
    ]);
    expect(rows.rows.find((row) => row.sku === "DEMO-B")).toMatchObject({ since: "2026-11-03", days_in_status: 7 });
    const expected: [NonNullable<SkuStockFilters["summary_metric"]>, string[]][] = [
      ["in_stock", ["DEMO-A", "DEMO-D"]], ["changed", ["DEMO-A", "DEMO-D"]],
      ["out_of_stock_7d", ["DEMO-B"]], ["fluctuating_30d", ["DEMO-D"]],
    ];
    for (const [summaryMetric, skus] of expected) {
      const filtered = await api.inventory.listSkus("fixture", {
        page: 1, pageSize: 0, filters: { summary_metric: summaryMetric },
      });
      expect(filtered.total).toBe(skus.length);
      expect(filtered.rows.map((row) => row.sku)).toEqual(skus);
    }
    const products = await api.products.list("fixture", { page: 1, pageSize: 0, filters: { parent_only: true } });
    expect(products.rows.find((row) => row.product_id === "DEMO-B")).toMatchObject({
      stock_status: "out_of_stock", variant_count: 2, in_stock_variants: 0,
    });
    expect(await readFile(path.join(project, PATHS.skuStockView))).toEqual(before);

    const configPath = path.join(project, PATHS.site);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.sku_grouping.enabled = false;
    config.crawl.auto_collect_products = true;
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    api.invalidate(project);
    expect((await api.inventory.summary("fixture")).product_management).toMatchObject({
      total_rows: 5, in_stock_rows: 2, online_rate: 0.4,
    });
    expect((await api.products.list("fixture", { page: 1, pageSize: 0,
      filters: { parent_only: true } })).rows.map((row) => row.product_id)).toEqual([
      "DEMO-A", "DEMO-B", "DEMO-C", "DEMO-D", "DEMO-E",
    ]);
  });

  it("does not turn missing business dates or missing event archives into false zeroes", async () => {
    const { project, api } = await syntheticProject();
    await unlink(path.join(project, PATHS.eventsDir, "2026-10.jsonl"));
    expect((await api.inventory.summary("fixture")).product_management).toMatchObject({
      as_of: AS_OF, changed_rows: 2, out_of_stock_7d_rows: 1, fluctuating_30d_rows: null,
    });
    expect((await api.inventory.listSkus("fixture", { page: 1, pageSize: 0,
      filters: { summary_metric: "fluctuating_30d" } })).total).toBe(0);
    const latestPath = path.join(project, PATHS.inventoryLatest);
    const latest = await readJsonl(latestPath);
    await writeJsonl(latestPath, latest.filter((row) => row.sku !== "DEMO-B02"), { primaryKey: ["sku"] });
    expect((await api.inventory.summary("fixture")).product_management?.out_of_stock_7d_rows).toBeNull();
    await unlink(path.join(project, PATHS.eventsDir, "2026-11.jsonl"));
    expect((await api.inventory.summary("fixture")).product_management?.changed_rows).toBeNull();
    await writeFile(path.join(project, PATHS.dailySummary), "");
    const summary = (await api.inventory.summary("fixture")).product_management;
    expect(summary).toMatchObject({ as_of: null, online_rate: null, changed_rows: null,
      out_of_stock_7d_rows: null, fluctuating_30d_rows: null });
    expect((await api.inventory.listSkus("fixture", { page: 1, pageSize: 0,
      filters: { summary_metric: "in_stock" } })).total).toBe(0);
  });
});
