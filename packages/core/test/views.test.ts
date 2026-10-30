import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PATHS,
  type EdmCampaign,
  type InventoryEvent,
  type InventoryLatest,
  type ProductView,
  type SkuRecord,
  type StockStatus,
} from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonl } from "../src/io/jsonl";
import { buildProductViews, buildViews } from "../src/views/build";

const TEMP_DIRS: string[] = [];
const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");

function makeSku(sku: string, handle: string, image: string | null): SkuRecord {
  return {
    sku,
    product_id: handle,
    handle,
    title: handle,
    variant_title: null,
    url: `https://example.com/${handle}`,
    category: "feeders",
    categories: ["feeders"],
    category_source: "feed",
    price: 12.5,
    compare_at_price: null,
    currency: "USD",
    image_url: image,
    status: "active",
    first_seen: "2026-10-19",
    last_seen: "2026-10-21",
    updated_at: "2026-10-21",
  };
}

function latest(sku: string, stockStatus: StockStatus): InventoryLatest {
  return {
    sku,
    stock_status: stockStatus,
    qty: null,
    since: "2026-10-19",
    checked_at: "2026-10-21T00:00:00-07:00",
  };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("buildViews", () => {
  it("matches the products golden file byte for byte and reconstructs 30-day stock history", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-views-"));
    TEMP_DIRS.push(tempRoot);
    const projectPath = path.join(tempRoot, "project");
    await cp(FIXTURE_PROJECT, projectPath, { recursive: true });

    const result = await buildViews(projectPath, { date: "2026-10-21" });
    const [actualProducts, expectedProducts, actualStock, expectedStock] = await Promise.all([
      readFile(path.join(projectPath, PATHS.productsView)),
      readFile(path.join(FIXTURE_PROJECT, PATHS.productsView)),
      readFile(path.join(projectPath, PATHS.skuStockView)),
      readFile(path.join(FIXTURE_PROJECT, PATHS.skuStockView)),
    ]);
    expect(actualProducts.equals(expectedProducts)).toBe(true);
    expect(actualStock.equals(expectedStock)).toBe(true);
    expect(result).toEqual({ products: 17, skuStock: 19 });

    const stockFile = actualStock.toString("utf8");
    const sku001 = stockFile.split("\n").map((line) => line ? JSON.parse(line) as Record<string, unknown> : null)
      .find((row) => row?.sku === "KYBF001");
    expect(sku001).toMatchObject({
      stock_status: "out_of_stock",
      since: "2026-10-20",
      days_in_status: 2,
      history_30d: `${"-".repeat(27)}ioo`,
      online_rate_7d: 1 / 3,
      online_rate_30d: 1 / 3,
      changes_30d: 1,
      last_change: "stock_change",
      last_change_at: "2026-10-20",
    });
    const sku010 = stockFile.split("\n").map((line) => line ? JSON.parse(line) as Record<string, unknown> : null)
      .find((row) => row?.sku === "KYBF010");
    expect(sku010?.price_history).toEqual([{ date: "2026-10-20", price: 24.5 }]);
    const sku000 = stockFile.split("\n").map((line) => line ? JSON.parse(line) as Record<string, unknown> : null)
      .find((row) => row?.sku === "KYBF000-G");
    expect(sku000).not.toHaveProperty("price_history");
  }, 20_000);

  it("builds price history from every recorded event month without backfilling current prices", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-views-price-history-"));
    TEMP_DIRS.push(tempRoot);
    const projectPath = path.join(tempRoot, "project");
    await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
    const events: InventoryEvent[] = [
      { date: "2026-10-22", sku: "KYBF001", type: "price_change", from: 12, to: 13, category: "bird-feeders", title: "Feeder" },
      { date: "2026-08-15", sku: "KYBF001", type: "price_change", from: 11, to: 12, category: "bird-feeders", title: "Feeder" },
      { date: "2026-08-01", sku: "KYBF001", type: "price_change", from: 10, to: 11, category: "bird-feeders", title: "Feeder" },
      { date: "2026-08-02", sku: "KYBF000-G", type: "new_sku", from: null, to: 19.99, category: "bird-feeders", title: "Feeder" },
      { date: "2026-08-03", sku: "KYBF003", type: "price_change", from: 20, to: "21", category: "bird-baths", title: "Bath" },
      { date: "2026-08-04", sku: "KYBF004-R", type: "price_change", from: 20, to: -1, category: "bird-baths", title: "Bath" },
    ];
    await writeFile(path.join(projectPath, PATHS.eventsDir, "2026-08.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    await buildViews(projectPath, { date: "2026-10-21" });
    const stockRows = (await readFile(path.join(projectPath, PATHS.skuStockView), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stockRows.find((row) => row.sku === "KYBF001")?.price_history).toEqual([
      { date: "2026-08-01", price: 11 },
      { date: "2026-08-15", price: 12 },
    ]);
    expect(stockRows.find((row) => row.sku === "KYBF000-G")).not.toHaveProperty("price_history");
    expect(stockRows.find((row) => row.sku === "KYBF003")).not.toHaveProperty("price_history");
    expect(stockRows.find((row) => row.sku === "KYBF004-R")).not.toHaveProperty("price_history");
  }, 20_000);

  it("writes parent mappings onto child rows without creating parent inventory or rates", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-views-grouping-"));
    TEMP_DIRS.push(tempRoot);
    const projectPath = path.join(tempRoot, "project");
    await cp(FIXTURE_PROJECT, projectPath, { recursive: true });

    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as Record<string, unknown>;
    site.sku_grouping = { enabled: true, rule: { type: "regex", value: "^(.+)-[A-Z]+$" } };
    await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`, "utf8");

    const skus = [makeSku("FAMILY-RED", "family", null), makeSku("FAMILY-BLUE", "family", null)];
    const latestRows = [latest("FAMILY-RED", "in_stock"), latest("FAMILY-BLUE", "out_of_stock")];
    await writeJsonl(path.join(projectPath, PATHS.skus), skus as unknown as Record<string, unknown>[], { primaryKey: ["sku"] });
    await writeJsonl(path.join(projectPath, PATHS.inventoryLatest), latestRows as unknown as Record<string, unknown>[], { primaryKey: ["sku"] });

    const result = await buildViews(projectPath, { date: "2026-10-21" });
    const stockRows = (await readFile(path.join(projectPath, PATHS.skuStockView), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.skuStock).toBe(2);
    expect(stockRows).toHaveLength(2);
    expect(stockRows.map((row) => row.sku)).toEqual(["FAMILY-BLUE", "FAMILY-RED"]);
    expect(stockRows.every((row) => row.parent_sku === "FAMILY")).toBe(true);
    expect(stockRows.find((row) => row.sku === "FAMILY-RED")).toMatchObject({
      stock_status: "in_stock",
      online_rate_7d: 1,
      online_rate_30d: 1,
    });
    expect(stockRows.find((row) => row.sku === "FAMILY-BLUE")).toMatchObject({
      stock_status: "out_of_stock",
      online_rate_7d: 0,
      online_rate_30d: 0,
    });
    expect(stockRows.some((row) => row.sku === "FAMILY")).toBe(false);
  }, 20_000);

  it("uses feed images before manual images, then falls back to manual and none", () => {
    const rows = [
      makeSku("A", "feed-first", null),
      makeSku("B", "feed-first", "https://cdn.example.com/feed.jpg"),
      makeSku("C", "manual-only", null),
      makeSku("D", "no-image", null),
    ];
    const views = buildProductViews(
      rows,
      rows.map((row) => latest(row.sku, "in_stock")),
      [
        { sku: "A", image_role: "main", image_url: "https://cdn.example.com/manual.jpg" },
        { sku: "C", image_role: "main", image_url: "https://cdn.example.com/only-manual.jpg" },
      ],
      [],
      [] as EdmCampaign[],
      "2026-10-21",
    );
    const byHandle = new Map(views.map((view: ProductView) => [view.handle, view]));

    expect(byHandle.get("feed-first")).toMatchObject({
      image_source: "feed",
      image_url: "https://cdn.example.com/feed.jpg",
      feed_image_url: "https://cdn.example.com/feed.jpg",
      manual_image_url: "https://cdn.example.com/manual.jpg",
    });
    expect(byHandle.get("manual-only")).toMatchObject({
      image_source: "manual",
      image_url: "https://cdn.example.com/only-manual.jpg",
      feed_image_url: null,
    });
    expect(byHandle.get("no-image")).toMatchObject({
      image_source: "none",
      image_url: null,
      feed_image_url: null,
      manual_image_url: null,
    });
  });
});
