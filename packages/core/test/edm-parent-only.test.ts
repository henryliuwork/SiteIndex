import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CSV_HEADERS, PATHS, type SkuRecord, type StockStatus } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";
import { readCsv, writeCsv } from "../src/io/csv";
import { writeJsonl, type JsonRecord } from "../src/io/jsonl";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-edm-parent-"));
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

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EDM parent-only image rows", () => {
  it("aggregates parent images, keeps collision SKUs single and applies parent edits to every child", async () => {
    const projectPath = await makeProject();
    const fixture = JSON.parse(await readFile(path.resolve(process.cwd(), "fixtures/inputs/v030-edm-parent-only.json"), "utf8")) as {
      rule: { type: "regex"; value: string };
      base_url: string;
      manual_images: { sku: string; image_url: string }[];
      rows: { sku: string; handle: string; title: string; stock_status: StockStatus; image_url: string | null }[];
    };
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8"));
    site.sku_grouping = { enabled: true, rule: fixture.rule };
    await writeFile(sitePath, JSON.stringify(site));
    const skuRows: SkuRecord[] = fixture.rows.map((row) => ({
      sku: row.sku,
      product_id: row.sku,
      handle: row.handle,
      title: row.title,
      variant_title: null,
      url: `${fixture.base_url}/products/${row.handle}`,
      category: "demo-catalog",
      category_source: "feed",
      price: 12,
      compare_at_price: null,
      currency: "USD",
      image_url: row.image_url,
      status: "active",
      first_seen: "2026-10-19",
      last_seen: "2026-10-21",
      updated_at: "2026-10-21",
    }));
    const latest = fixture.rows.map((row) => ({
      sku: row.sku, stock_status: row.stock_status, qty: null, since: "2026-10-19", checked_at: "2026-10-21T12:00:00Z",
    }));
    await writeJsonl(path.join(projectPath, PATHS.skus), skuRows as unknown as JsonRecord[], { primaryKey: ["sku"] });
    await writeJsonl(path.join(projectPath, PATHS.inventoryLatest), latest, { primaryKey: ["sku"] });
    await writeCsv(path.join(projectPath, PATHS.skuMedia), fixture.manual_images.map((row) => ({
      ...row, image_role: "main", alt_text: null, source: "cdn", width: null, height: null, updated_at: "2026-10-21",
    })), CSV_HEADERS.skuMedia, ["sku", "image_role"]);
    const api = service(projectPath);

    const parentRows = await api.edm.listImages("fixture", { page: 1, pageSize: 0, filters: { parent_only: true } });
    expect(parentRows.total).toBe(5);
    expect(parentRows.rows.map((row) => row.sku)).toEqual([
      "DEMO001A", "DEMO003C", "DEMO003C01", "DEMO003C02", "DEMO004D",
    ]);
    expect(parentRows.rows[0]).toMatchObject({
      sku: "DEMO001A", title: "Demo Parent A - Child 01", variant_title: null, stock_status: "in_stock",
      feed_image_url: "https://images.example.test/feed-a01.jpg",
      manual_image_url: "https://images.example.test/manual-a02.jpg", used: "feed",
    });
    expect((await api.edm.listImages("fixture", {
      page: 1, pageSize: 10, search: "DEMO001A02", filters: { parent_only: true },
    })).rows.map((row) => row.sku)).toEqual(["DEMO001A"]);
    expect((await api.edm.listImages("fixture", {
      page: 1, pageSize: 10, filters: { parent_only: true, view: "in_stock" },
    })).rows.map((row) => row.sku)).toEqual(["DEMO001A", "DEMO003C01"]);
    expect((await api.edm.listImages("fixture", { page: 1, pageSize: 0 })).total).toBe(fixture.rows.length);

    const updated = await api.edm.setManualImage("fixture", "DEMO001A", "https://images.example.test/parent.jpg");
    expect(updated).toMatchObject({ sku: "DEMO001A", manual_image_url: "https://images.example.test/parent.jpg" });
    const ledger = await readCsv(path.join(projectPath, PATHS.skuMedia));
    expect(ledger.filter((row) => ["DEMO001A01", "DEMO001A02"].includes(String(row.sku))).map((row) => row.image_url))
      .toEqual(["https://images.example.test/parent.jpg", "https://images.example.test/parent.jpg"]);

    site.sku_grouping.enabled = false;
    await writeFile(sitePath, JSON.stringify(site));
    api.invalidate(projectPath);
    expect((await api.edm.listImages("fixture", { page: 1, pageSize: 0, filters: { parent_only: true } })).total)
      .toBe(fixture.rows.length);
  }, 30_000);
});
