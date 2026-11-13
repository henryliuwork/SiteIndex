import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CSV_HEADERS, PATHS, pathsFor, type PathKey } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";
import { writeCsv } from "../src/io/csv";
import { writeJsonl, type JsonRecord } from "../src/io/jsonl";

const roots: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-todo-service-"));
  roots.push(root);
  const projectPath = path.join(root, "project");
  const paths = pathsFor("legacy");
  await mkdir(projectPath, { recursive: true });
  await mkdir(path.dirname(path.join(projectPath, paths.site)), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const previousMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0)).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const before = new Date(Date.now() - 60_000).toISOString();
  await writeFile(path.join(projectPath, paths.site), `${JSON.stringify({
    schema_version: "1.0", domain: "example.test", base_url: "https://example.test", platform: "custom",
    currency: "USD", locale: "en-US", timezone: "UTC", brand: { name: "Synthetic" },
    crawl: { feed_url: ["https://feed.example.test/products.xml"], sku_field: "id", category_depth: 1 },
    categories: { mode: "feed" }, edm: { image_priority: ["feed", "manual"] },
  }, null, 2)}\n`);

  const writeRows = (key: PathKey, rows: readonly JsonRecord[]) => writeJsonl(path.join(projectPath, paths[key]), rows, {
    primaryKey: key === "seoIssues" ? ["url", "rule"] : ["sku"],
  });
  await writeRows("skus", [
    { sku: "DEMO-UNKNOWN", product_id: "product-unknown", handle: "unknown", title: "Synthetic unknown", url: "https://example.test/products/unknown", category: "demo", categories: ["demo"], price: 10, compare_at_price: null, currency: "USD", image_url: null, status: "active", first_seen: today, last_seen: today },
    { sku: "DEMO-IMAGE", product_id: "product-image", handle: "image", title: "Synthetic image gap", url: "https://example.test/products/image", category: "demo", categories: ["demo"], price: 12, compare_at_price: null, currency: "USD", image_url: null, status: "active", first_seen: today, last_seen: today },
  ]);
  await writeRows("inventoryLatest", [
    { sku: "DEMO-UNKNOWN", date: today, stock_status: "unknown" },
    { sku: "DEMO-IMAGE", date: today, stock_status: "in_stock" },
  ]);
  await writeRows("skuStockView", [
    { sku: "DEMO-UNKNOWN", title: "Synthetic unknown", stock_status: "unknown", price: 10 },
    { sku: "DEMO-IMAGE", title: "Synthetic image gap", stock_status: "in_stock", price: 12 },
  ]);
  await writeRows("seoIssues", [{
    url: "https://example.test/products/demo", rule: "http_4xx", severity: "high", detail: "虚构页面返回 404。", status: "open",
  }]);
  await writeRows("productsView", []);
  await writeRows("productDetails", []);
  await writeRows("seoPages", []);
  await writeRows("seoLinks", []);
  await writeRows("blogIndex", []);
  await writeRows("keywords", []);
  await writeRows("edmCampaigns", []);
  await writeRows("runs", [{
    run_id: "synthetic-daily", job: "daily", trigger: "manual", device_name: "Test", started_at: before,
    finished_at: now, status: "ok",
  }]);
  await writeCsv(path.join(projectPath, paths.skuMedia), [], CSV_HEADERS.skuMedia, ["sku"]);
  await writeCsv(path.join(projectPath, paths.skuTags), [], CSV_HEADERS.skuTags, ["sku"]);
  await writeCsv(path.join(projectPath, paths.dailySummary), [{ date: today, category: "_all", total: 2, in_stock: 1, out_of_stock: 0, preorder: 0, unknown: 1 }], CSV_HEADERS.dailySummary, ["date", "category"]);
  const eventsPath = path.join(projectPath, paths.eventsDir, `${today.slice(0, 7)}.jsonl`);
  await writeJsonl(eventsPath, [], { primaryKey: ["date", "sku"] });
  await writeJsonl(path.join(projectPath, paths.eventsDir, `${previousMonth.slice(0, 7)}.jsonl`), [
    { date: previousMonth, sku: "DEMO-REMOVED", type: "feed_anomaly" },
  ], { primaryKey: ["date", "sku"] });
  return projectPath;
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: (id) => id === "demo" ? projectPath : path.join(projectPath, "missing"),
    deviceId: "todo-test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core project todos", () => {
  it("scans local sources, preserves manual fields, and retains findings on partial or failed scans", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    const first = await api.todos.list("demo");
    expect(first.scan.status).toBe("complete");
    const seo = first.items.find((item) => item.finding.rule_id === "seo.issue.http_4xx");
    const unknownStock = first.items.find((item) => item.finding.rule_id === "inventory.unknown_stock");
    const edmImage = first.items.find((item) => item.finding.rule_id === "edm.promotable_missing_usable_image");
    const feedAnomaly = first.items.find((item) => item.finding.rule_id === "inventory.feed_anomaly");
    expect(seo?.finding.sources).toContainEqual(expect.objectContaining({ path: "seoIssues", record_key: "https://example.test/products/demo\u0000http_4xx" }));
    expect(unknownStock?.finding.sources.map((source) => source.path)).toEqual(expect.arrayContaining(["skus", "inventoryLatest"]));
    expect(edmImage?.finding.sources.map((source) => source.path)).toEqual(expect.arrayContaining(["skus", "skuStockView", "site"]));
    expect(feedAnomaly?.finding.subject.key).toBe("DEMO-REMOVED");
    expect(feedAnomaly?.finding.sources.map((source) => source.path)).toContain("eventsDir");
    expect(seo?.state).toMatchObject({ status: "open", note: null });
    expect(await readFile(path.join(projectPath, pathsFor("legacy").todoStates), "utf8").catch(() => "")).toBe("");
    expect(seo?.finding.sources.every((source) => Number.isFinite(Date.parse(source.collected_at)))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const repeated = await api.todos.list("demo");
    const repeatedSeo = repeated.items.find((item) => item.finding.dedupe_key === seo?.finding.dedupe_key);
    expect(repeatedSeo?.finding.first_seen_at).toBe(seo?.finding.first_seen_at);
    expect(Date.parse(repeatedSeo?.finding.last_seen_at ?? "") >= Date.parse(seo?.finding.last_seen_at ?? "")).toBe(true);

    await api.todos.update("demo", { dedupe_key: seo!.finding.dedupe_key, status: "in_progress", note: "合成备注" });
    await api.todos.update("demo", { dedupe_key: unknownStock!.finding.dedupe_key, status: "done", note: "缺少库存快照" });
    const afterUpdate = await api.todos.list("demo");
    expect(afterUpdate.items.find((item) => item.finding.dedupe_key === seo!.finding.dedupe_key)?.state)
      .toMatchObject({ status: "in_progress", note: "合成备注" });
    expect((await api.todos.history("demo", seo!.finding.dedupe_key)).map((event) => event.action))
      .toEqual(["status_changed", "note_changed"]);

    const latestPath = path.join(projectPath, pathsFor("legacy").inventoryLatest);
    const latestBytes = await readFile(latestPath);
    await rm(latestPath);
    const partial = await api.todos.list("demo");
    expect(partial.scan.status).toBe("partial");
    expect(partial.items.find((item) => item.finding.dedupe_key === seo!.finding.dedupe_key)?.state)
      .toMatchObject({ status: "in_progress", note: "合成备注" });
    expect(partial.items.find((item) => item.finding.dedupe_key === unknownStock!.finding.dedupe_key)?.state)
      .toMatchObject({ status: "done", note: "缺少库存快照", absence_confirmed_at: null });
    expect(partial.items.some((item) => item.finding.dedupe_key === seo!.finding.dedupe_key)).toBe(true);
    await writeFile(latestPath, latestBytes);

    const issuePath = path.join(projectPath, pathsFor("legacy").seoIssues);
    const issueBytes = await readFile(issuePath);
    await writeFile(issuePath, "{broken\n");
    const failed = await api.todos.list("demo");
    expect(failed.scan.status).toBe("failed");
    expect(failed.items.find((item) => item.finding.dedupe_key === seo!.finding.dedupe_key)?.state)
      .toMatchObject({ status: "in_progress", note: "合成备注" });
    await writeFile(issuePath, issueBytes);
  }, 30_000);

  it("reopens a completed rule finding only after a complete absence and reappearance", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    const initial = await api.todos.list("demo");
    const seo = initial.items.find((item) => item.finding.rule_id === "seo.issue.http_4xx")!;
    await api.todos.update("demo", { dedupe_key: seo.finding.dedupe_key, status: "done", note: "人工确认" });

    const issuePath = path.join(projectPath, pathsFor("legacy").seoIssues);
    await writeJsonl(issuePath, [], { primaryKey: ["url", "rule"] });
    const absent = await api.todos.list("demo");
    expect(absent.scan.status).toBe("complete");
    expect(absent.items.some((item) => item.finding.dedupe_key === seo.finding.dedupe_key)).toBe(false);

    await writeJsonl(issuePath, [{
      url: "https://example.test/products/demo", rule: "http_4xx", severity: "high", detail: "虚构页面仍返回 404。", status: "open",
    }], { primaryKey: ["url", "rule"] });
    const returned = await api.todos.list("demo");
    expect(returned.items.find((item) => item.finding.dedupe_key === seo.finding.dedupe_key)?.state)
      .toMatchObject({ status: "pending_review", note: "人工确认", absence_confirmed_at: null });
    expect((await api.todos.history("demo", seo.finding.dedupe_key)).at(-1)).toMatchObject({
      action: "rule_reopened", from_status: "done", to_status: "pending_review",
    });
  }, 30_000);
});
