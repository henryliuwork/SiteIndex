import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CSV_HEADERS, pathsFor, type ProjectLayout } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];
const COLLECTED_AT = "2026-11-12T08:30:00.000Z";

interface SyntheticSku {
  sku: string;
  status?: "active" | "removed";
  category?: string;
  image_url?: string | null;
  currency?: string;
  handle?: string;
}

interface SyntheticStock {
  sku: string;
  stock_status: "in_stock" | "out_of_stock" | "preorder" | "unknown";
}

interface SyntheticTag {
  sku: string;
  tags?: string | null;
  priority?: string | null;
  exclude_edm?: string | null;
  discount_tier?: string | null;
}

interface SyntheticMedia {
  sku: string;
  image_role: "main";
  image_url: string;
}

async function makeProject(layout: ProjectLayout = "legacy", options: { grouping?: boolean } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "siteindex-edm-scenarios-"));
  TEMP_DIRS.push(temp);
  const projectPath = path.join(temp, "synthetic-project");
  const paths = pathsFor(layout);
  await mkdir(path.join(projectPath, paths.index), { recursive: true });
  await writeFile(path.join(projectPath, paths.site), `${JSON.stringify({
    schema_version: "1.0",
    domain: "shop.example.test",
    currency: "USD",
    edm: { cooldown_days: 21, image_priority: ["feed", "manual"], discount_tiers: [10] },
    ...(options.grouping ? { sku_grouping: { enabled: true, rule: { type: "separator", value: "-" } } } : {}),
  })}\n`, "utf8");
  return { projectPath, paths };
}

function sku(skuId: string, options: Omit<SyntheticSku, "sku"> = {}): Record<string, unknown> {
  return {
    sku: skuId,
    product_id: `product-${options.handle ?? skuId}`,
    handle: options.handle ?? `demo-${skuId.toLowerCase()}`,
    title: `Synthetic ${skuId}`,
    variant_title: null,
    url: `https://shop.example.test/products/${skuId.toLowerCase()}`,
    category: options.category ?? "Accessories",
    category_source: "feed",
    price: 20,
    compare_at_price: 25,
    currency: options.currency ?? "USD",
    image_url: options.image_url ?? null,
    status: options.status ?? "active",
  };
}

async function writeJsonl(projectPath: string, relative: string, rows: readonly object[]): Promise<void> {
  const target = path.join(projectPath, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(target, text ? `${text}\n` : "", "utf8");
}

async function writeCsv(projectPath: string, relative: string, headers: readonly string[], rows: readonly Record<string, string | null>[]): Promise<void> {
  const target = path.join(projectPath, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => row[header] ?? "").join(","))];
  await writeFile(target, `${lines.join("\n")}\n`, "utf8");
}

async function populate(
  projectPath: string,
  paths: ReturnType<typeof pathsFor>,
  options: { skus: SyntheticSku[]; stock?: SyntheticStock[]; tags?: SyntheticTag[]; media?: SyntheticMedia[]; lastFeatured?: Record<string, string | null>; campaigns?: readonly Record<string, unknown>[] },
): Promise<void> {
  await Promise.all([
    writeJsonl(projectPath, paths.skus, options.skus.map(({ sku: skuId, ...overrides }) => sku(skuId, overrides))),
    writeJsonl(projectPath, paths.skuStockView, (options.stock ?? options.skus.map(({ sku: skuId }) => ({ sku: skuId, stock_status: "in_stock" as const }))).map((row) => ({
      sku: row.sku, title: `Synthetic ${row.sku}`, stock_status: row.stock_status, price: 20,
    }))),
    writeJsonl(projectPath, paths.edmCampaigns, options.campaigns ?? options.skus.flatMap((row) => {
      const date = options.lastFeatured?.[row.sku];
      return date ? [{
        campaign_id: `synthetic-campaign-${row.sku}`,
        date,
        theme: "Synthetic campaign",
        status: "sent",
        handles: [row.handle ?? `demo-${row.sku.toLowerCase()}`],
      }] : [];
    })),
    writeJsonl(projectPath, paths.runs, [{
      run_id: "synthetic-daily", job: "daily", started_at: "2026-11-12T08:00:00.000Z",
      finished_at: COLLECTED_AT, status: "ok",
    }]),
    writeCsv(projectPath, paths.skuMedia, CSV_HEADERS.skuMediaV2, (options.media ?? []).map((row) => ({
      sku: row.sku, image_role: row.image_role, image_url: row.image_url,
      alt_text: null, source: "cdn", width: null, height: null, updated_at: "2026-11-12",
    }))),
    writeCsv(projectPath, paths.skuTags, CSV_HEADERS.skuTagsV2, (options.tags ?? []).map((row) => ({
      sku: row.sku, tags: row.tags ?? null, priority: row.priority ?? null,
      exclude_edm: row.exclude_edm ?? null, email_blurb: null, season: null, note: null,
      updated_at: "2026-11-12", discount_tier: row.discount_tier ?? null,
    }))),
  ]);
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

describe("EDM scenario queries", () => {
  it.each(["legacy", "workspace"] as const)("returns filtered, stable factual candidates for the %s layout", async (layout) => {
    const { projectPath, paths } = await makeProject(layout);
    await populate(projectPath, paths, {
      skus: [
        { sku: "DEMO-A", image_url: "https://images.example.test/a.jpg" },
        { sku: "DEMO-B", image_url: "https://images.example.test/b.jpg", category: "Accessories" },
        { sku: "DEMO-C", category: "Shoes" },
      ],
      stock: [
        { sku: "DEMO-A", stock_status: "in_stock" },
        { sku: "DEMO-B", stock_status: "out_of_stock" },
        { sku: "DEMO-C", stock_status: "in_stock" },
      ],
      tags: [
        { sku: "DEMO-A", tags: "Blue; SUMMER", priority: "4", discount_tier: "10" },
        { sku: "DEMO-B", tags: "blue" },
        { sku: "DEMO-C", tags: "summer", exclude_edm: "1" },
      ],
    });
    const edm = service(projectPath).edm;

    const defaults = await edm.candidates("synthetic", {});
    expect(defaults.data?.rows.map((row) => row.sku)).toEqual(["DEMO-A"]);
    expect(defaults.data?.total).toBe(1);
    expect(defaults.data?.rows[0]).toMatchObject({
      tags: ["blue", "summer"], stock_status: "in_stock", image_source: "feed", priority: 4, discount_tier: 10,
    });
    expect(defaults.metadata).toMatchObject({ collected_at: COLLECTED_AT, quality: "complete", missing_fields: [], anomalies: [] });

    const tagged = await edm.candidates("synthetic", { tag: " BLUE ", stock: "any", limit: 1 });
    expect(tagged.data).toMatchObject({ total: 2, rows: [{ sku: "DEMO-A" }] });
    const excluded = await edm.candidates("synthetic", { category: "shoes", include_excluded: true });
    expect(excluded.data?.rows.map((row) => row.sku)).toEqual(["DEMO-C"]);
  });

  it("creates parent candidates only in the query view and retains ungrouped SKUs", async () => {
    const { projectPath, paths } = await makeProject("legacy", { grouping: true });
    await populate(projectPath, paths, {
      skus: [
        { sku: "DEMO-PARENT-RED", image_url: "https://images.example.test/one.jpg", handle: "demo-family" },
        { sku: "DEMO-PARENT-BLUE", image_url: "https://images.example.test/two.jpg", handle: "demo-family" },
        { sku: "DEMOSINGLE", image_url: "https://images.example.test/single.jpg" },
      ],
      stock: [
        { sku: "DEMO-PARENT-RED", stock_status: "in_stock" },
        { sku: "DEMO-PARENT-BLUE", stock_status: "out_of_stock" },
        { sku: "DEMOSINGLE", stock_status: "in_stock" },
      ],
      tags: [
        { sku: "DEMO-PARENT-RED", tags: "summer" },
        { sku: "DEMO-PARENT-BLUE", tags: "blue" },
      ],
    });
    const result = await service(projectPath).edm.candidates("synthetic", { parent_only: true, stock: "any" });
    expect(result.data?.rows.map((row) => row.sku)).toEqual(["DEMO-PARENT", "DEMOSINGLE"]);
    expect(result.data?.rows[0]).toMatchObject({ stock_status: "in_stock", price: 20, tags: ["blue", "summer"] });
  });

  it.each(["legacy", "workspace"] as const)("keeps a real feed parent once in %s queries", async (layout) => {
    const { projectPath, paths } = await makeProject(layout);
    await writeFile(path.join(projectPath, paths.site), JSON.stringify({
      schema_version: "1.0", domain: "shop.example.test", currency: "USD",
      edm: { cooldown_days: 21, image_priority: ["feed", "manual"], discount_tiers: [10] },
      sku_grouping: { enabled: true, rule: { type: "regex", value: "^(.*CP)\\d+$", parent_source: "feed" } },
    }));
    await populate(projectPath, paths, {
      skus: [{ sku: "DEMOCP" }, { sku: "DEMOCP01", image_url: "https://images.example.test/child.jpg" }, { sku: "MISSINGCP01" }],
      stock: [{ sku: "DEMOCP", stock_status: "out_of_stock" }, { sku: "DEMOCP01", stock_status: "in_stock" }, { sku: "MISSINGCP01", stock_status: "unknown" }],
    });
    const edm = service(projectPath).edm;
    const result = await edm.candidates("synthetic", { parent_only: true, stock: "any" });
    expect(result.data?.rows.map((row) => row.sku)).toEqual(["DEMOCP", "MISSINGCP01"]);
    expect(result.data?.rows[0]).toMatchObject({ stock_status: "out_of_stock", image_url: "https://images.example.test/child.jpg" });
    const gaps = await edm.mediaGaps("synthetic", { parent_only: true, stock: "any" });
    expect(gaps.data?.rows.map((row) => row.sku)).toEqual(["MISSINGCP01"]);
  });

  it("reports absent and incompatible images without fetching or exposing unsafe URLs", async () => {
    const { projectPath, paths } = await makeProject();
    await populate(projectPath, paths, {
      skus: [
        { sku: "DEMO-WEBP", image_url: "https://images.example.test/webp.webp?utm_campaign=synthetic" },
        { sku: "DEMO-MISSING" },
        { sku: "DEMO-MANUAL", image_url: "https://user:secret@images.example.test/private.jpg" },
      ],
      media: [{ sku: "DEMO-MANUAL", image_role: "main", image_url: "https://images.example.test/manual.png" }],
    });
    const result = await service(projectPath).edm.mediaGaps("synthetic", { stock: "any" });
    expect(result.data?.rows).toEqual([
      {
        sku: "DEMO-MISSING", title: "Synthetic DEMO-MISSING", stock_status: "in_stock", reason: "missing",
        feed_image_url: null, manual_image_url: null,
      },
      {
        sku: "DEMO-WEBP", title: "Synthetic DEMO-WEBP", stock_status: "in_stock", reason: "webp_only",
        feed_image_url: "https://images.example.test/webp.webp", manual_image_url: null,
      },
    ]);
  });

  it("marks filtered unknown-stock SKUs as incomplete in candidate and media-gap metadata", async () => {
    const { projectPath, paths } = await makeProject();
    await populate(projectPath, paths, {
      skus: [
        { sku: "DEMO-STOCKED", image_url: "https://images.example.test/stocked.jpg" },
        { sku: "DEMO-STOCK-MISSING" },
      ],
      stock: [{ sku: "DEMO-STOCKED", stock_status: "in_stock" }],
    });
    const edm = service(projectPath).edm;

    const candidates = await edm.candidates("synthetic", {});
    expect(candidates.data?.rows.map((row) => row.sku)).toEqual(["DEMO-STOCKED"]);
    expect(candidates.metadata).toMatchObject({
      quality: "partial",
      missing_fields: ["views.sku_stock.sku"],
      anomalies: [expect.objectContaining({ code: "SKU_STOCK_MISSING", severity: "warning" })],
    });

    const mediaGaps = await edm.mediaGaps("synthetic", {});
    expect(mediaGaps.data).toEqual({ rows: [], total: 0 });
    expect(mediaGaps.metadata).toMatchObject({
      quality: "partial",
      missing_fields: ["views.sku_stock.sku"],
      anomalies: [expect.objectContaining({ code: "SKU_STOCK_MISSING", severity: "warning" })],
    });
  });

  it("reports local campaign blockers and warnings deterministically without sending", async () => {
    const { projectPath, paths } = await makeProject();
    await populate(projectPath, paths, {
      skus: [
        { sku: "DEMO-OK", image_url: "https://images.example.test/ok.jpg" },
        { sku: "DEMO-OOS" },
        { sku: "DEMO-WEBP", image_url: "https://images.example.test/webp.webp" },
        { sku: "DEMO-EUR", image_url: "https://images.example.test/eur.png", currency: "EUR" },
      ],
      stock: [
        { sku: "DEMO-OK", stock_status: "in_stock" },
        { sku: "DEMO-OOS", stock_status: "out_of_stock" },
        { sku: "DEMO-WEBP", stock_status: "in_stock" },
        { sku: "DEMO-EUR", stock_status: "in_stock" },
      ],
      tags: [
        { sku: "DEMO-OK", discount_tier: "10" },
        { sku: "DEMO-WEBP", exclude_edm: "1", discount_tier: "99" },
      ],
      lastFeatured: { "DEMO-WEBP": "2026-11-15" },
    });
    const result = await service(projectPath).edm.campaignSafety("synthetic", {
      campaign_date: "2026-11-30",
      skus: ["DEMO-OK", "DEMO-OOS", "DEMO-WEBP", "DEMO-EUR", "DEMO-OK", "DEMO-NOT-FOUND"],
    });
    expect(result.data?.status).toBe("blocked");
    expect(result.data?.checked_skus).toEqual(["DEMO-EUR", "DEMO-NOT-FOUND", "DEMO-OK", "DEMO-OOS", "DEMO-WEBP"]);
    expect(result.data?.findings.map(({ code, sku }) => [code, sku])).toEqual([
      ["cooldown_active", "DEMO-WEBP"],
      ["currency_mismatch", "DEMO-EUR"],
      ["discount_tier_invalid", "DEMO-WEBP"],
      ["duplicate_sku", "DEMO-OK"],
      ["excluded_from_edm", "DEMO-WEBP"],
      ["missing_image", "DEMO-OOS"],
      ["out_of_stock", "DEMO-OOS"],
      ["sku_not_found", "DEMO-NOT-FOUND"],
      ["webp_only", "DEMO-WEBP"],
    ]);
    expect(result.metadata.quality).toBe("complete");
  });

  it("uses the latest campaign on or before the requested date, ignoring a later scheduled campaign", async () => {
    const { projectPath, paths } = await makeProject();
    await populate(projectPath, paths, {
      skus: [{ sku: "DEMO-COOLDOWN", image_url: "https://images.example.test/cooldown.jpg" }],
      campaigns: [
        {
          campaign_id: "synthetic-sent-campaign",
          date: "2026-11-15",
          theme: "Synthetic previous campaign",
          status: "sent",
          handles: ["demo-demo-cooldown"],
        },
        {
          campaign_id: "synthetic-future-campaign",
          date: "2026-12-10",
          theme: "Synthetic future campaign",
          status: "scheduled",
          handles: ["demo-demo-cooldown"],
        },
      ],
    });

    const result = await service(projectPath).edm.campaignSafety("synthetic", {
      campaign_date: "2026-11-30",
      skus: ["DEMO-COOLDOWN"],
    });

    expect(result.data?.findings).toContainEqual(expect.objectContaining({ code: "cooldown_active", sku: "DEMO-COOLDOWN" }));
    expect(result.data?.status).toBe("needs_review");
  });

  it("does not claim a clear preflight when required indexed inputs are absent", async () => {
    const { projectPath, paths } = await makeProject();
    await writeJsonl(projectPath, paths.skus, [sku("DEMO-PARTIAL", { image_url: "https://images.example.test/partial.jpg" })]);
    const result = await service(projectPath).edm.campaignSafety("synthetic", { campaign_date: "2026-11-30", skus: ["DEMO-PARTIAL"] });
    expect(result.data?.status).toBe("needs_review");
    expect(result.data?.findings).toEqual([]);
    expect(result.metadata.quality).not.toBe("complete");
    expect(result.metadata.missing_fields).toEqual(expect.arrayContaining(["views.sku_stock", "logs.runs"]));
  });
});
