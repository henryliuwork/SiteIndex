import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathsFor, type ProjectLayout } from "@siteindex/shared";
import { readJsonl, runDaily, type DailySnapshot } from "../src";

const roots: string[] = [];
const fixtureDir = path.join(process.cwd(), "fixtures");
const fixedNow = new Date("2026-10-22T01:49:31.000Z");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(site: Record<string, unknown>, layout: ProjectLayout = "legacy") {
  const project = await mkdtemp(path.join(os.tmpdir(), "siteindex-daily-"));
  roots.push(project);
  const paths = pathsFor(layout);
  await mkdir(path.join(project, paths.index), { recursive: true });
  await writeFile(path.join(project, paths.site), JSON.stringify(site, null, 2) + "\n", "utf8");
  return project;
}

async function compareNormalizedJsonl(actualPath: string, expectedPath: string, normalizedFields: string[]) {
  const normalize = async (file: string) => {
    const text = await readFile(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const field of normalizedFields) if (Object.hasOwn(row, field)) row[field] = "<normalized>";
      return JSON.stringify(row);
    }).join("\n") + (text.endsWith("\n") ? "\n" : "");
  };
  expect(await normalize(actualPath)).toBe(await normalize(expectedPath));
}

describe("daily sync", () => {
  it("matches golden files day1–4 and leaves sync data unchanged when the removal guard trips", async () => {
    const site = JSON.parse(await readFile(path.join(fixtureDir, "inputs", "site.json"), "utf8")) as Record<string, unknown>;
    const paths = pathsFor("legacy");
    const project = await newProject(site);
    const days = [
      ["day1", "2026-10-19", 0],
      ["day2", "2026-10-20", 0],
      ["day3", "2026-10-21", 0],
      ["day4", "2026-10-22", 3],
    ] as const;

    for (const [name, day, expectedCode] of days) {
      const snapshot = await readJsonl(path.join(fixtureDir, "expected", "snapshots", `${name}.jsonl`)) as DailySnapshot[];
      const result = await runDaily(project, snapshot, { date: day, now: fixedNow });
      expect(result.exitCode).toBe(expectedCode);

      const expectedDir = path.join(fixtureDir, "expected", "steps", name);
      const projectDir = path.join(project, "index");
      const files: [string, string][] = [
        [path.join(projectDir, "catalog", "skus.jsonl"), path.join(expectedDir, "skus.jsonl")],
        [path.join(projectDir, "inventory", "daily_summary.csv"), path.join(expectedDir, "daily_summary.csv")],
        [path.join(projectDir, "inventory", "events", "2026-10.jsonl"), path.join(expectedDir, "events.jsonl")],
      ];
      for (const [actual, expected] of files) expect(await readFile(actual, "utf8")).toBe(await readFile(expected, "utf8"));
      await compareNormalizedJsonl(
        path.join(projectDir, "inventory", "latest.jsonl"), path.join(expectedDir, "latest.jsonl"), ["checked_at"],
      );
      expect(await readFile(path.join(expectedDir, "exit_code"), "utf8")).toBe(`${result.exitCode}\n`);

      if (day !== "2026-10-22") {
        const report = await readFile(path.join(projectDir, "reports", "daily", `${day}.md`), "utf8");
        expect(report).toBe(await readFile(path.join(fixtureDir, "expected", "project", "index", "reports", "daily", `${day}.md`), "utf8"));
      }
    }
    const actualRuns = (await readJsonl(path.join(project, paths.runs))).filter((row) => row.job === "daily");
    const expectedRuns = (await readJsonl(path.join(fixtureDir, "expected", "project", "index", "logs", "runs.jsonl")))
      .filter((row) => row.job === "daily");
    const normalizeRuns = (rows: Record<string, unknown>[]) => rows.map((row) => ({
      ...row, started_at: "<normalized>", finished_at: "<normalized>",
    }));
    expect(normalizeRuns(actualRuns)).toEqual(normalizeRuns(expectedRuns));
  }, 30_000);

  it("writes workspace daily outputs byte-for-byte like the legacy golden files", async () => {
    const site = JSON.parse(await readFile(path.join(fixtureDir, "inputs", "site.json"), "utf8")) as Record<string, unknown>;
    const project = await newProject(site, "workspace");
    const paths = pathsFor("workspace");
    const snapshot = await readJsonl(path.join(fixtureDir, "expected", "snapshots", "day1.jsonl")) as DailySnapshot[];

    const result = await runDaily(project, snapshot, { date: "2026-10-19", now: fixedNow });

    expect(result.exitCode).toBe(0);
    const expectedDir = path.join(fixtureDir, "expected", "steps", "day1");
    expect(await readFile(path.join(project, paths.skus), "utf8")).toBe(await readFile(path.join(expectedDir, "skus.jsonl"), "utf8"));
    expect(await readFile(path.join(project, paths.dailySummary), "utf8")).toBe(await readFile(path.join(expectedDir, "daily_summary.csv"), "utf8"));
    expect(await readFile(path.join(project, paths.eventsDir, "2026-10.jsonl"), "utf8")).toBe(await readFile(path.join(expectedDir, "events.jsonl"), "utf8"));
    await compareNormalizedJsonl(path.join(project, paths.inventoryLatest), path.join(expectedDir, "latest.jsonl"), ["checked_at"]);
    expect(await readFile(path.join(project, "index", "catalog", "skus.jsonl")).catch(() => null)).toBeNull();
  }, 20_000);

  it("writes the selected category and source for feed, URL-rule, and manual modes", async () => {
    const snapshot: DailySnapshot = {
      sku: "SKU-1", product_id: "P1", handle: "product", title: "Product", variant_title: null,
      url: "https://shop.example/collections/bird-feeders/products/product", category: "feed-category",
      categories: ["feed-category"], price: 10, compare_at_price: null, currency: "USD", image_url: null,
      stock_status: "in_stock", qty: null, product_type: "Bird Feeders > Tube",
    };
    const cases = [
      { config: { mode: "feed" }, category: "feed-category", source: "feed" },
      { config: { mode: "url_rule", url_pattern: "/collections/{slug}" }, category: "bird-feeders", source: "url_rule" },
      { config: { mode: "manual", manual: [{ slug: "manual-match", match: [{ type: "product_type_contains", value: "Bird Feeders" }] }, { slug: "second", match: [{ type: "sku_prefix", value: "SKU" }] }] }, category: "manual-match", source: "manual" },
      { config: { mode: "manual", manual: [{ slug: "no-hit", match: [{ type: "sku_prefix", value: "OTHER" }] }] }, category: "uncategorized", source: "none" },
    ] as const;

    for (const { config, category, source } of cases) {
      const project = await newProject({ domain: "shop.example", timezone: "UTC", categories: config });
      const paths = pathsFor("legacy");
      const result = await runDaily(project, [snapshot], { date: "2026-10-22", now: fixedNow });
      expect(result.exitCode).toBe(0);
      const [row] = await readJsonl(path.join(project, paths.skus));
      expect(row).toMatchObject({ category, category_source: source });
    }
  }, 30_000);

  it("preserves a file changed during stock verification instead of committing results from the earlier snapshot", async () => {
    const project = await newProject({
      domain: "shop.example",
      base_url: "https://shop.example",
      timezone: "UTC",
      crawl: {
        max_removed_ratio: 1,
        rate_limit_ms: 0,
        stock_verify: { enabled: true, max_per_run: 1 },
      },
    });
    const paths = pathsFor("legacy");
    const skuPath = path.join(project, paths.skus);
    const latestPath = path.join(project, paths.inventoryLatest);
    await mkdir(path.dirname(skuPath), { recursive: true });
    await mkdir(path.dirname(latestPath), { recursive: true });
    const beforeSkuBytes = Buffer.from(`${JSON.stringify({
      sku: "DEMO-OLD",
      title: "Old item",
      url: "https://shop.example/products/old-item",
      category: "demo",
      status: "active",
      first_seen: "2026-10-01",
      last_seen: "2026-10-21",
      updated_at: "2026-10-21",
    })}\n`);
    const externalSkuBytes = Buffer.from(`${JSON.stringify({
      sku: "DEMO-OLD",
      title: "User edit during verification",
      url: "https://shop.example/products/old-item",
      category: "demo",
      status: "active",
      first_seen: "2026-10-01",
      last_seen: "2026-10-21",
      updated_at: "2026-10-21",
    })}\n`);
    const latestBytes = Buffer.from(`${JSON.stringify({
      sku: "DEMO-OLD", stock_status: "in_stock", qty: 4, since: "2026-10-01", checked_at: "2026-10-21T00:00:00Z",
    })}\n`);
    await writeFile(skuPath, beforeSkuBytes);
    await writeFile(latestPath, latestBytes);
    vi.stubGlobal("fetch", async () => {
      await writeFile(skuPath, externalSkuBytes);
      return new Response("", { status: 404 });
    });

    const newSku: DailySnapshot = {
      sku: "DEMO-NEW",
      title: "New item",
      url: "https://shop.example/products/new-item",
      category: "demo",
      stock_status: "in_stock",
    };

    await expect(runDaily(project, [newSku], { date: "2026-10-22", now: fixedNow }))
      .rejects.toThrow("首次读取后目标文件已被其他进程修改");

    expect(await readFile(skuPath)).toEqual(externalSkuBytes);
    expect(await readFile(latestPath)).toEqual(latestBytes);
    await expect(readFile(path.join(project, paths.jobLogsDir, "daily-output-transaction.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it.each([
    { mode: "verification disabled", verify: { enabled: false }, snapshotSku: "DEMO-NEW" },
    { mode: "no verification candidates", verify: { enabled: true, max_per_run: 1 }, snapshotSku: "DEMO-OLD" },
    { mode: "zero verification limit", verify: { enabled: true, max_per_run: 0 }, snapshotSku: "DEMO-NEW" },
  ])("checks the initial bytes in every daily path ($mode)", async ({ verify, snapshotSku }) => {
    const project = await newProject({
      domain: "shop.example",
      base_url: "https://shop.example",
      timezone: "UTC",
      crawl: { max_removed_ratio: 1, rate_limit_ms: 0, stock_verify: verify },
    });
    const paths = pathsFor("legacy");
    const skuPath = path.join(project, paths.skus);
    const latestPath = path.join(project, paths.inventoryLatest);
    await mkdir(path.dirname(skuPath), { recursive: true });
    await mkdir(path.dirname(latestPath), { recursive: true });
    const originalSku = {
      sku: "DEMO-OLD",
      title: "Old item",
      url: "https://shop.example/products/old-item",
      category: "demo",
      status: "active",
      first_seen: "2026-10-01",
      last_seen: "2026-10-21",
      updated_at: "2026-10-21",
    };
    const externalSkuBytes = Buffer.from(`${JSON.stringify({ ...originalSku, title: "Concurrent user edit" })}\n`);
    const latestBytes = Buffer.from(`${JSON.stringify({
      sku: "DEMO-OLD", stock_status: "in_stock", qty: 4, since: "2026-10-01", checked_at: "2026-10-21T00:00:00Z",
    })}\n`);
    await writeFile(skuPath, `${JSON.stringify(originalSku)}\n`);
    await writeFile(latestPath, latestBytes);
    vi.stubGlobal("fetch", async () => { throw new Error("No network request expected for this case"); });
    const inputSku = snapshotSku === "DEMO-OLD"
      ? { sku: "DEMO-OLD", title: "Old item", url: "https://shop.example/products/old-item", category: "demo", stock_status: "in_stock" }
      : { sku: "DEMO-NEW", title: "New item", url: "https://shop.example/products/new-item", category: "demo", stock_status: "in_stock" };

    await expect(runDaily(project, [inputSku], {
      date: "2026-10-22",
      now: fixedNow,
      beforeOutputCommit: async () => { await writeFile(skuPath, externalSkuBytes); },
    })).rejects.toThrow("首次读取后目标文件已被其他进程修改");

    expect(await readFile(skuPath)).toEqual(externalSkuBytes);
    expect(await readFile(latestPath)).toEqual(latestBytes);
    await expect(readFile(path.join(project, paths.jobLogsDir, "daily-output-transaction.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
