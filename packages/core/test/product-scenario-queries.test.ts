import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type InventoryEvent, type RunLog, type SiteConfig, type SkuRecord, type SkuStockView } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];
const DAILY_FINISHED_AT = "2026-11-12T08:30:00.000Z";

function runLog(status: RunLog["status"] = "ok"): RunLog {
  return {
    run_id: "synthetic-daily-1",
    job: "daily",
    trigger: "manual",
    started_at: "2026-11-12T08:00:00.000Z",
    finished_at: DAILY_FINISHED_AT,
    status,
  };
}

function skuRecord(sku: string, status: SkuRecord["status"] = "active"): SkuRecord {
  return {
    sku,
    product_id: `product-${sku}`,
    handle: `demo-${sku.toLowerCase()}`,
    title: `Synthetic ${sku}`,
    variant_title: null,
    url: `https://shop.example.test/products/${sku.toLowerCase()}`,
    category: "synthetic-category",
    category_source: "feed",
    price: 12.5,
    compare_at_price: 15,
    currency: "USD",
    image_url: null,
    status,
    first_seen: "2026-11-01",
    last_seen: "2026-11-12",
    updated_at: "2026-11-12",
  };
}

function stockView(sku: string): SkuStockView {
  return {
    sku,
    title: `Synthetic ${sku}`,
    variant_title: null,
    category: "synthetic-category",
    price: 12.5,
    stock_status: "in_stock",
    since: "2026-11-12",
    days_in_status: 1,
    online_rate_7d: 100,
    online_rate_30d: 100,
    history_30d: "i".repeat(30),
    changes_30d: 0,
    last_change: null,
    last_change_at: null,
  };
}

function event(sku: string, date: string, type: InventoryEvent["type"] = "stock_change"): InventoryEvent {
  return {
    date,
    sku,
    type,
    from: type === "stock_change" ? "out_of_stock" : null,
    to: type === "stock_change" ? "in_stock" : 12.5,
    category: "synthetic-category",
    title: `Synthetic ${sku} change`,
  };
}

async function makeProject(
  layout: "legacy" | "workspace" = "legacy",
  config: Partial<SiteConfig> = {},
): Promise<{ projectPath: string; paths: ReturnType<typeof pathsFor>; layout: "legacy" | "workspace" }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-product-scenarios-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "synthetic-project");
  const paths = pathsFor(layout);
  await mkdir(path.join(projectPath, paths.index), { recursive: true });
  await writeFile(path.join(projectPath, paths.site), `${JSON.stringify({
    schema_version: "1.1",
    domain: "shop.example.test",
    base_url: "https://shop.example.test",
    timezone: "UTC",
    ...config,
  })}\n`, "utf8");
  return { projectPath, paths, layout };
}

async function writeRows(projectPath: string, relativePath: string, rows: readonly object[]): Promise<void> {
  const filePath = path.join(projectPath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "synthetic-test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("product scenario queries", () => {
  it.each(["legacy", "workspace"] as const)("reads SKU brief with daily collection time from %s layout", async (layout) => {
    const { projectPath, paths } = await makeProject(layout);
    await Promise.all([
      writeRows(projectPath, paths.skus, [skuRecord("DEMO-BRIEF")]),
      writeRows(projectPath, paths.skuStockView, [stockView("DEMO-BRIEF")]),
      writeRows(projectPath, paths.runs, [runLog()]),
    ]);

    const result = await service(projectPath).products.skuBrief!("fixture", "DEMO-BRIEF");
    expect(result.data).toEqual({ sku: skuRecord("DEMO-BRIEF"), stock: stockView("DEMO-BRIEF") });
    expect(result.metadata).toMatchObject({
      collected_at: DAILY_FINISHED_AT,
      missing_fields: [],
      quality: "complete",
      anomalies: [],
    });
    expect(result.metadata.sources.map((item) => item.kind)).toEqual(["catalog.skus", "logs.runs", "views.sku_stock"]);
  });

  it("returns null stock and reports missing or corrupt companion data without inventing records", async () => {
    const { projectPath, paths } = await makeProject();
    await writeRows(projectPath, paths.skus, [skuRecord("DEMO-MISSING-STOCK")]);
    await writeRows(projectPath, paths.runs, [runLog()]);
    const api = service(projectPath);

    const missingStock = await api.products.skuBrief!("fixture", "DEMO-MISSING-STOCK");
    expect(missingStock.data).toEqual({ sku: skuRecord("DEMO-MISSING-STOCK"), stock: null });
    expect(missingStock.metadata.missing_fields).toContain("views.sku_stock");

    const unknownSku = await api.products.skuBrief!("fixture", "DEMO-NOT-IN-INDEX");
    expect(unknownSku.data).toBeNull();
    expect(unknownSku.metadata.missing_fields).toContain("catalog.skus.sku");
    expect(unknownSku.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "SKU_NOT_INDEXED" }));

    await writeRows(projectPath, paths.skuStockView, [stockView("DEMO-MISSING-STOCK")]);
    await writeFile(path.join(projectPath, paths.skus), "{broken json\n", "utf8");
    const corruptCatalog = await api.products.skuBrief!("fixture", "DEMO-MISSING-STOCK");
    expect(corruptCatalog.data).toBeNull();
    expect(corruptCatalog.metadata.quality).toBe("unreliable");
    expect(corruptCatalog.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "SOURCE_INVALID", field: "catalog.skus" }));
  });

  it("returns deterministically sorted project-wide and exact SKU event history", async () => {
    const { projectPath, paths } = await makeProject("workspace");
    const events = [
      event("DEMO-B", "2026-11-11"),
      event("DEMO-A", "2026-11-10"),
      event("DEMO-A", "2026-11-12", "price_change"),
    ];
    await writeRows(projectPath, path.join(paths.eventsDir, "2026-11.jsonl"), events);
    await writeRows(projectPath, paths.runs, [runLog()]);
    const api = service(projectPath);

    const all = await api.products.changes!("fixture");
    const oneSku = await api.products.changes!("fixture", "DEMO-A");
    expect(all.data).toEqual([events[1], events[0], events[2]]);
    expect(oneSku.data).toEqual([events[1], events[2]]);
    expect(all.metadata.collected_at).toBe(DAILY_FINISHED_AT);
    expect(all.metadata.quality).toBe("complete");
  });

  it("reports missing events and unknown collection time", async () => {
    const { projectPath } = await makeProject();
    const result = await service(projectPath).products.changes!("fixture");
    expect(result.data).toBeNull();
    expect(result.metadata.collected_at).toBeNull();
    expect(result.metadata.missing_fields).toEqual(expect.arrayContaining(["inventory.events", "logs.runs"]));
  });

  it.each(["legacy", "workspace"] as const)("returns stored stock for every real family member in %s layout", async (layout) => {
    const { projectPath, paths } = await makeProject(layout, {
      sku_grouping: { enabled: true, rule: { type: "separator", value: "-" } },
    });
    const rows = [skuRecord("DEMOPARENT-01"), skuRecord("DEMOPARENT-02")];
    await Promise.all([
      writeRows(projectPath, paths.skus, rows),
      writeRows(projectPath, paths.skuStockView, rows.map((row) => stockView(row.sku))),
      writeRows(projectPath, paths.runs, [runLog()]),
    ]);
    const child = await service(projectPath).products.groupFamily!("fixture", "DEMOPARENT-02");
    expect(child.data).toEqual({
      sku: "DEMOPARENT-02",
      role: "child",
      parent_sku: "DEMOPARENT",
      child_skus: ["DEMOPARENT-01", "DEMOPARENT-02"],
      collision: null,
      members: [
        { sku: "DEMOPARENT-01", role: "child", stock: stockView("DEMOPARENT-01") },
        { sku: "DEMOPARENT-02", role: "child", stock: stockView("DEMOPARENT-02") },
      ],
    });
    expect(child.metadata.collected_at).toBe(DAILY_FINISHED_AT);
    expect(child.data?.members?.map((member) => member.sku)).not.toContain("DEMOPARENT");

    await writeRows(projectPath, paths.skus, [...rows, skuRecord("DEMOPARENT")]);
    await writeRows(projectPath, paths.skuStockView, [...rows.map((row) => stockView(row.sku)), stockView("DEMOPARENT")]);
    const collision = await service(projectPath).products.groupFamily!("fixture", "DEMOPARENT");
    expect(collision.data).toEqual({
      sku: "DEMOPARENT",
      role: "collision",
      parent_sku: "DEMOPARENT",
      child_skus: ["DEMOPARENT-01", "DEMOPARENT-02"],
      collision: { parent: "DEMOPARENT", children: ["DEMOPARENT-01", "DEMOPARENT-02"] },
      members: [
        { sku: "DEMOPARENT", role: "parent", stock: stockView("DEMOPARENT") },
        { sku: "DEMOPARENT-01", role: "child", stock: stockView("DEMOPARENT-01") },
        { sku: "DEMOPARENT-02", role: "child", stock: stockView("DEMOPARENT-02") },
      ],
    });
  });

  it.each(["legacy", "workspace"] as const)("returns the real feed parent and child stock in %s layout", async (layout) => {
    const { projectPath, paths } = await makeProject(layout, {
      sku_grouping: { enabled: true, rule: { type: "regex", value: "^(.*CP)\\d+$", parent_source: "feed" } },
    });
    const rows = [skuRecord("DEMOCP"), skuRecord("DEMOCP01"), skuRecord("MISSINGCP01")];
    await Promise.all([
      writeRows(projectPath, paths.skus, rows),
      writeRows(projectPath, paths.skuStockView, rows.map((row) => stockView(row.sku))),
      writeRows(projectPath, paths.runs, [runLog()]),
    ]);
    const api = service(projectPath);
    for (const sku of ["DEMOCP", "DEMOCP01"]) {
      const family = await api.products.groupFamily!("fixture", sku);
      expect(family.data).toMatchObject({ parent_sku: "DEMOCP", child_skus: ["DEMOCP01"], collision: null,
        members: [{ sku: "DEMOCP", role: "parent", stock: stockView("DEMOCP") },
          { sku: "DEMOCP01", role: "child", stock: stockView("DEMOCP01") }] });
    }
    expect((await api.products.groupFamily!("fixture", "MISSINGCP01")).data?.role).toBe("single");
  });

  it.each(["legacy", "workspace"] as const)("keeps real family members and reports missing stock rows/sources in %s layout", async (layout) => {
    const { projectPath, paths } = await makeProject(layout, {
      sku_grouping: { enabled: true, rule: { type: "separator", value: "-" } },
    });
    const rows = [skuRecord("DEMOFAMILY-01"), skuRecord("DEMOFAMILY-02")];
    await Promise.all([
      writeRows(projectPath, paths.skus, rows),
      writeRows(projectPath, paths.skuStockView, [stockView("DEMOFAMILY-01")]),
      writeRows(projectPath, paths.runs, [runLog()]),
    ]);
    const api = service(projectPath);

    const partial = await api.products.groupFamily!("fixture", "DEMOFAMILY-01");
    expect(partial.data?.members).toEqual([
      { sku: "DEMOFAMILY-01", role: "child", stock: stockView("DEMOFAMILY-01") },
      { sku: "DEMOFAMILY-02", role: "child", stock: null },
    ]);
    expect(partial.metadata.missing_fields).toContain("views.sku_stock.DEMOFAMILY-02");
    expect(partial.metadata.anomalies).toContainEqual(expect.objectContaining({
      code: "SKU_STOCK_NOT_INDEXED",
      field: "views.sku_stock.DEMOFAMILY-02",
    }));

    await rm(path.join(projectPath, paths.skuStockView), { force: true });
    const missingSource = await api.products.groupFamily!("fixture", "DEMOFAMILY-01");
    expect(missingSource.data?.members).toEqual([
      { sku: "DEMOFAMILY-01", role: "child", stock: null },
      { sku: "DEMOFAMILY-02", role: "child", stock: null },
    ]);
    expect(missingSource.metadata.missing_fields).toContain("views.sku_stock");
    expect(missingSource.metadata.anomalies).toContainEqual(expect.objectContaining({
      code: "SOURCE_MISSING",
      field: "views.sku_stock",
    }));
  });

  it("reports a real SKU as single when grouping is not configured and reports bad grouping rules", async () => {
    const { projectPath, paths } = await makeProject();
    await Promise.all([
      writeRows(projectPath, paths.skus, [skuRecord("DEMO-SINGLE")]),
      writeRows(projectPath, paths.runs, [runLog("partial")]),
    ]);
    const api = service(projectPath);
    const single = await api.products.groupFamily!("fixture", "DEMO-SINGLE");
    expect(single.data).toEqual({
      sku: "DEMO-SINGLE",
      role: "single",
      parent_sku: null,
      child_skus: [],
      collision: null,
      members: [{ sku: "DEMO-SINGLE", role: "single", stock: null }],
    });
    expect(single.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "SKU_GROUPING_NOT_CONFIGURED" }));
    expect(single.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "DAILY_LATEST_NOT_SUCCESSFUL" }));

    await writeFile(path.join(projectPath, paths.site), JSON.stringify({ sku_grouping: { enabled: true, rule: { type: "regex", value: "(" } } }), "utf8");
    const invalid = await api.products.groupFamily!("fixture", "DEMO-SINGLE");
    expect(invalid.data).toBeNull();
    expect(invalid.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "SKU_GROUPING_RULE_INVALID", severity: "unreliable" }));
  });
});
