import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type ProductView, type SkuRecord, type SkuStockView, type StockStatus } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";
import { writeJsonl, type JsonRecord } from "../src/io/jsonl";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-product-variants-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  return projectPath;
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: (id) => id === "fixture" ? projectPath : path.join(projectPath, "missing"),
    deviceId: "test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

function productRow(handle: string, records: readonly SkuRecord[], stock: readonly SkuStockView[]): ProductView {
  const first = records[0]!;
  const statuses = stock.map((row) => row.stock_status);
  const stockStatus: StockStatus = statuses.includes("in_stock") ? "in_stock"
    : statuses.includes("preorder") ? "preorder"
      : statuses.includes("out_of_stock") ? "out_of_stock" : "unknown";
  const prices = records.map((row) => row.price);
  return {
    handle,
    product_id: first.product_id,
    title: first.title,
    url: first.url,
    category: first.category,
    categories: [first.category],
    price_min: Math.min(...prices),
    price_max: Math.max(...prices),
    compare_at_max: null,
    currency: first.currency,
    on_sale: false,
    image_url: first.image_url,
    image_source: "none",
    feed_image_url: first.image_url,
    manual_image_url: null,
    variant_count: records.length,
    skus: records.map((row) => row.sku),
    in_stock_variants: statuses.filter((status) => status === "in_stock").length,
    stock_status: stockStatus,
    stock_since: "2026-11-01",
    tags: [],
    priority: null,
    exclude_edm: 0,
    last_featured: null,
    days_since_featured: null,
    first_seen: "2026-11-01",
    status: "active",
  };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("product detail variant stock", () => {
  it("returns group siblings across handles and same-handle variants in stable SKU order", async () => {
    const projectPath = await makeProject();
    const fixture = JSON.parse(await readFile(path.resolve(process.cwd(), "fixtures/inputs/v030-product-detail-variants.json"), "utf8")) as {
      rule: { type: "regex"; value: string };
      rows: { sku: string; handle: string; title: string; stock_status: StockStatus; price: number }[];
    };
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8"));
    site.sku_grouping = { enabled: true, rule: fixture.rule };
    await writeFile(sitePath, JSON.stringify(site));

    const records: SkuRecord[] = fixture.rows.map((row) => ({
      sku: row.sku,
      product_id: row.sku,
      handle: row.handle,
      title: row.title,
      variant_title: null,
      url: `https://catalog.example.test/products/${row.handle}`,
      category: "demo-catalog",
      category_source: "feed",
      price: row.price,
      compare_at_price: null,
      currency: "USD",
      image_url: null,
      status: "active",
      first_seen: "2026-11-01",
      last_seen: "2026-11-05",
      updated_at: "2026-11-05",
    }));
    const stock: SkuStockView[] = fixture.rows.map((row) => ({
      sku: row.sku,
      title: row.title,
      variant_title: null,
      category: "demo-catalog",
      price: row.price,
      stock_status: row.stock_status,
      since: "2026-11-02",
      days_in_status: 4,
      online_rate_7d: 0.5,
      online_rate_30d: 0.75,
      history_30d: "iop".repeat(10),
      changes_30d: 2,
      last_change: "stock_change",
      last_change_at: "2026-11-04",
    }));
    const byHandle = new Map<string, SkuRecord[]>();
    for (const row of records) byHandle.set(row.handle, [...(byHandle.get(row.handle) ?? []), row]);
    const products = [...byHandle].map(([handle, rows]) => productRow(handle, rows, stock.filter((item) => rows.some((row) => row.sku === item.sku))));
    await writeJsonl(path.join(projectPath, PATHS.skus), records as unknown as JsonRecord[], { primaryKey: ["sku"] });
    await writeJsonl(path.join(projectPath, PATHS.skuStockView), stock as unknown as JsonRecord[], { primaryKey: ["sku"] });
    await writeJsonl(path.join(projectPath, PATHS.productsView), products as unknown as JsonRecord[], { primaryKey: ["handle"] });
    const api = service(projectPath);

    const grouped = await api.products.get("fixture", "demo-a-01");
    expect(grouped.skus.map((row) => row.sku)).toEqual(["DEMO010A01"]);
    expect(grouped.variants?.map((row) => row.sku)).toEqual(["DEMO010A01", "DEMO010A02", "DEMO010A03"]);
    expect(grouped.variants).toMatchObject([
      { sku: "DEMO010A01", stock_status: "in_stock", since: "2026-11-02", days_in_status: 4, price: 19.5, history_30d: "iop".repeat(10), online_rate_30d: 0.75 },
      { sku: "DEMO010A02", stock_status: "out_of_stock", price: 20.5 },
      { sku: "DEMO010A03", stock_status: "preorder", price: 21.5 },
    ]);
    const sameHandle = await api.products.get("fixture", "demo-independent");
    expect(sameHandle.variants?.map((row) => row.sku)).toEqual(["DEMO011B", "DEMO011B-ALT"]);

    site.sku_grouping.enabled = false;
    await writeFile(sitePath, JSON.stringify(site));
    api.invalidate(projectPath);
    expect((await api.products.get("fixture", "demo-a-01")).variants?.map((row) => row.sku)).toEqual(["DEMO010A01"]);
  }, 30_000);
});
