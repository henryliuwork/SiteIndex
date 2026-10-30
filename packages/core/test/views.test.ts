import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PATHS,
  type EdmCampaign,
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
    const [actualProducts, expectedProducts, stockFile] = await Promise.all([
      readFile(path.join(projectPath, PATHS.productsView)),
      readFile(path.join(FIXTURE_PROJECT, PATHS.productsView)),
      readFile(path.join(projectPath, PATHS.skuStockView), "utf8"),
    ]);
    expect(actualProducts.equals(expectedProducts)).toBe(true);
    expect(result).toEqual({ products: 17, skuStock: 19 });

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
