import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CSV_HEADERS, pathsFor } from "@siteindex/shared";
import { afterEach, expect, it, vi } from "vitest";
import { compareKeys } from "../src/io/compare";
import { createCoreService } from "../src/service";

const roots: string[] = [];
const base = "https://shop.example.test";
const target = `${base}/demo-page`;
const source = `${base}/source-page`;
const finishedAt = "2026-11-18T08:30:00.000Z";
const fixture = new URL("../../../fixtures/scenarios-v070/golden.jsonl", import.meta.url);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareKeys(a, b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

async function writeRows(root: string, relative: string, rows: readonly object[]): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

async function syntheticProject(): Promise<string> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "siteindex-v070-golden-"));
  roots.push(temp);
  const project = path.join(temp, "synthetic-project");
  const p = pathsFor("workspace");
  await mkdir(path.join(project, p.index), { recursive: true });
  await writeFile(path.join(project, p.site), `${JSON.stringify({
    schema_version: "1.1", domain: "shop.example.test", base_url: base, timezone: "UTC", currency: "USD",
    sku_grouping: { enabled: true, rule: { type: "separator", value: "-" } },
    edm: { cooldown_days: 21, image_priority: ["feed", "manual"], discount_tiers: [10] },
  })}\n`, "utf8");
  const skus = ["DEMOFAMILY-01", "DEMOFAMILY-02", "DEMOSINGLE"].map((sku, index) => ({
    sku, product_id: `product-${sku}`, handle: `demo-${sku.toLowerCase()}`, title: `Synthetic ${sku}`,
    variant_title: null, url: `${base}/products/${sku.toLowerCase()}`, category: "Synthetic",
    category_source: "feed", price: 20, compare_at_price: 25, currency: "USD",
    image_url: index === 2 ? `${base}/images/single.webp` : `${base}/images/family.jpg`,
    status: "active", first_seen: "2026-11-01", last_seen: "2026-11-18", updated_at: "2026-11-18",
  }));
  const stock = skus.map((sku, index) => ({
    sku: sku.sku, title: sku.title, variant_title: null, category: "Synthetic", price: 20,
    stock_status: index === 1 ? "out_of_stock" : "in_stock", since: "2026-11-18",
    days_in_status: 1, online_rate_7d: 100, online_rate_30d: 100,
    history_30d: "i".repeat(30), changes_30d: 0, last_change: null, last_change_at: null,
  }));
  const page = (url: string) => ({
    url, page_type: "page", status_code: 200, title: "Synthetic page", title_length: 14,
    meta_description: "Synthetic description", description_length: 22, h1: "Synthetic heading",
    h1_count: 1, canonical: url, canonical_status: "self", robots_meta: null, x_robots_tag: null,
    indexable: true, in_sitemap: true, schema_types: [], word_count: 24, last_crawled: "2026-11-18",
  });
  await Promise.all([
    writeRows(project, p.skus, skus),
    writeRows(project, p.skuStockView, stock),
    writeRows(project, path.join(p.eventsDir, "2026-11.jsonl"), [{
      date: "2026-11-18", sku: "DEMOFAMILY-01", type: "price_change", from: 18, to: 20,
      category: "Synthetic", title: "Synthetic price change",
    }]),
    writeRows(project, p.seoPages, [page(target), page(source)]),
    writeRows(project, p.seoIssues, [{
      url: target, rule: "title_missing", severity: "mid", detail: "Synthetic issue", status: "open",
      first_seen: "2026-11-18", last_seen: "2026-11-18",
    }]),
    writeRows(project, p.seoLinks, [{ from: source, to: target, anchor: "demo", to_type: "page", nofollow: false }]),
    writeRows(project, p.runs, ["daily", "weekly"].map((job) => ({
      run_id: `synthetic-${job}`, job, trigger: "manual", started_at: "2026-11-18T08:00:00.000Z",
      finished_at: finishedAt, status: "ok",
    }))),
    writeRows(project, p.edmCampaigns, []),
  ]);
  for (const [relative, headers] of [[p.skuMedia, CSV_HEADERS.skuMediaV2], [p.skuTags, CSV_HEADERS.skuTagsV2]] as const) {
    const file = path.join(project, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${headers.join(",")}\n`, "utf8");
  }
  return project;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("matches all nine read-only scenario query golden envelopes byte for byte", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00.000Z"));
  const project = await syntheticProject();
  const api = createCoreService({ resolveProject: () => project, deviceId: "synthetic-device",
    cacheDir: path.join(path.dirname(project), "cache") });
  const results = await Promise.all([
    api.products.skuBrief!("fixture", "DEMOFAMILY-01"),
    api.products.changes!("fixture", "DEMOFAMILY-01"),
    api.products.groupFamily!("fixture", "DEMOFAMILY-02"),
    api.seo.pageBrief!("fixture", target),
    api.seo.issueCandidates!("fixture", target),
    api.seo.internalLinkContext!("fixture", target),
    api.edm.candidates!("fixture", { stock: "any", limit: 2 }),
    api.edm.mediaGaps!("fixture", { stock: "any" }),
    api.edm.campaignSafety!("fixture", { campaign_date: "2026-11-20", skus: ["DEMOSINGLE"] }),
  ]);
  const names = ["products.skuBrief", "products.changes", "products.groupFamily", "seo.pageBrief",
    "seo.issueCandidates", "seo.internalLinkContext", "edm.candidates", "edm.mediaGaps", "edm.campaignSafety"];
  const actual = results.map((result, index) => JSON.stringify(canonical({ method: names[index], result }))).join("\n") + "\n";
  expect(actual).toBe(await readFile(fixture, "utf8"));
});

it("keeps missing sources and an unindexed page explicit", async () => {
  const project = await syntheticProject();
  const p = pathsFor("workspace");
  await Promise.all([p.skus, p.skuStockView, p.eventsDir, p.seoPages, p.seoIssues, p.seoLinks, p.runs,
    p.edmCampaigns, p.skuMedia, p.skuTags].map((relative) => rm(path.join(project, relative), { recursive: true, force: true })));
  const api = createCoreService({ resolveProject: () => project, deviceId: "synthetic-device",
    cacheDir: path.join(path.dirname(project), "cache") });
  const results = await Promise.all([
    api.products.skuBrief!("fixture", "MISSING"), api.products.changes!("fixture", "MISSING"),
    api.products.groupFamily!("fixture", "MISSING"), api.seo.pageBrief!("fixture", target),
    api.seo.issueCandidates!("fixture", target), api.seo.internalLinkContext!("fixture", target),
    api.edm.candidates!("fixture", {}), api.edm.mediaGaps!("fixture", {}),
    api.edm.campaignSafety!("fixture", { campaign_date: "2026-11-20", skus: ["MISSING"] }),
  ]);
  for (const result of results) {
    expect(result.metadata.quality).not.toBe("complete");
    expect(result.metadata.missing_fields.length).toBeGreaterThan(0);
  }
  expect(results.slice(0, 8).every((result) => result.data === null)).toBe(true);
  expect(results[8]?.data).toMatchObject({ status: "needs_review" });

  const indexed = await syntheticProject();
  const indexedApi = createCoreService({ resolveProject: () => indexed, deviceId: "synthetic-device",
    cacheDir: path.join(path.dirname(indexed), "cache") });
  for (const result of await Promise.all([
    indexedApi.seo.pageBrief!("fixture", `${base}/missing-page`),
    indexedApi.seo.internalLinkContext!("fixture", `${base}/missing-page`),
  ])) {
    expect(result.data).toBeNull();
    expect(result.metadata.anomalies.map((item) => item.code)).toContain("PAGE_NOT_INDEXED");
  }
});

it("caps EDM rows to the requested limit while retaining the full synthetic total", async () => {
  const project = await syntheticProject();
  const p = pathsFor("workspace");
  const skus = Array.from({ length: 10_000 }, (_, index) => `DEMO${String(index).padStart(5, "0")}`);
  await Promise.all([
    writeRows(project, p.skus, skus.map((sku) => ({
      sku, product_id: sku, handle: sku.toLowerCase(), title: `Synthetic ${sku}`,
      variant_title: null, url: `${base}/products/${sku.toLowerCase()}`, category: "Synthetic",
      category_source: "feed", price: 20, compare_at_price: 25, currency: "USD",
      image_url: `${base}/images/${sku.toLowerCase()}.webp`, status: "active",
      first_seen: "2026-11-01", last_seen: "2026-11-18", updated_at: "2026-11-18",
    }))),
    writeRows(project, p.skuStockView, skus.map((sku) => ({
      sku, title: `Synthetic ${sku}`, stock_status: "in_stock", price: 20,
    }))),
  ]);
  const edm = createCoreService({ resolveProject: () => project, deviceId: "synthetic-device",
    cacheDir: path.join(path.dirname(project), "cache") }).edm;
  const [candidates, gaps] = await Promise.all([
    edm.candidates!("fixture", { limit: 200 }), edm.mediaGaps!("fixture", { limit: 200 }),
  ]);
  expect(candidates.data?.total).toBe(10_000);
  expect(candidates.data?.rows).toHaveLength(200);
  expect(gaps.data?.total).toBe(10_000);
  expect(gaps.data?.rows).toHaveLength(200);
  expect(candidates.data?.rows[0]?.sku).toBe("DEMO00000");
  expect(gaps.data?.rows.at(-1)?.sku).toBe("DEMO00199");
});

const benchmark = process.env.SITEINDEX_SCENARIO_BENCH === "1" ? it : it.skip;
benchmark("records nine query times for 10,000 synthetic SKUs and 50,000 synthetic pages", async () => {
  const project = await syntheticProject();
  const p = pathsFor("workspace");
  const skus = Array.from({ length: 10_000 }, (_, index) => `DEMO${String(index).padStart(5, "0")}`);
  await Promise.all([
    writeRows(project, p.skus, skus.map((sku) => ({
      sku, product_id: sku, handle: sku.toLowerCase(), title: `Synthetic ${sku}`,
      variant_title: null, url: `${base}/products/${sku.toLowerCase()}`, category: "Synthetic",
      category_source: "feed", price: 20, compare_at_price: 25, currency: "USD",
      image_url: `${base}/images/${sku.toLowerCase()}.jpg`, status: "active",
      first_seen: "2026-11-01", last_seen: "2026-11-18", updated_at: "2026-11-18",
    }))),
    writeRows(project, p.skuStockView, skus.map((sku) => ({
      sku, title: `Synthetic ${sku}`, stock_status: "in_stock", price: 20,
    }))),
    writeRows(project, path.join(p.eventsDir, "2026-11.jsonl"), skus.map((sku) => ({
      date: "2026-11-18", sku, type: "price_change", from: 18, to: 20,
      category: "Synthetic", title: "Synthetic price change",
    }))),
    writeRows(project, p.seoPages, Array.from({ length: 50_000 }, (_, index) => ({
      url: index === 0 ? target : `${base}/page-${index}`, page_type: "page", status_code: 200,
      title: "Synthetic page", title_length: 14, meta_description: "Synthetic description",
      description_length: 22, h1: "Synthetic heading", h1_count: 1, canonical: index === 0 ? target : `${base}/page-${index}`,
      canonical_status: "self", robots_meta: null, x_robots_tag: null, indexable: true,
      in_sitemap: true, schema_types: [], word_count: 24, last_crawled: "2026-11-18",
    }))),
    writeRows(project, p.seoIssues, Array.from({ length: 50_000 }, (_, index) => ({
      url: index === 0 ? target : `${base}/page-${index}`, rule: "title_missing", severity: "mid",
      detail: "Synthetic issue", status: "open", first_seen: "2026-11-18", last_seen: "2026-11-18",
    }))),
    writeRows(project, p.seoLinks, Array.from({ length: 50_000 }, (_, index) => ({
      from: index === 0 ? target : `${base}/page-${index}`, to: index === 0 ? source : `${base}/page-${index + 1}`,
      anchor: "demo", to_type: "page", nofollow: false,
    }))),
  ]);
  const api = createCoreService({ resolveProject: () => project, deviceId: "synthetic-device",
    cacheDir: path.join(path.dirname(project), "cache") });
  const queries: [string, () => Promise<unknown>][] = [
    ["products.skuBrief", () => api.products.skuBrief!("fixture", "DEMO00000")],
    ["products.changes", () => api.products.changes!("fixture", "DEMO00000")],
    ["products.groupFamily", () => api.products.groupFamily!("fixture", "DEMO00000")],
    ["seo.pageBrief", () => api.seo.pageBrief!("fixture", target)],
    ["seo.issueCandidates", () => api.seo.issueCandidates!("fixture", target)],
    ["seo.internalLinkContext", () => api.seo.internalLinkContext!("fixture", target)],
    ["edm.candidates", () => api.edm.candidates!("fixture", { limit: 200 })],
    ["edm.mediaGaps", () => api.edm.mediaGaps!("fixture", { limit: 200 })],
    ["edm.campaignSafety", () => api.edm.campaignSafety!("fixture", { campaign_date: "2026-11-20", skus: ["DEMO00000"] })],
  ];
  const timings: Record<string, number> = {};
  for (const [name, query] of queries) {
    const start = performance.now();
    await query();
    timings[name] = Math.round(performance.now() - start);
  }
  console.log(`scenario-benchmark ${JSON.stringify(timings)}`);
}, 120_000);
