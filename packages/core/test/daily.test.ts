import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS } from "@siteindex/shared";
import { readJsonl, runDaily, type DailySnapshot } from "../src";

const roots: string[] = [];
const fixtureDir = path.join(process.cwd(), "fixtures");
const fixedNow = new Date("2026-10-22T01:49:31.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(site: Record<string, unknown>) {
  const project = await mkdtemp(path.join(os.tmpdir(), "siteindex-daily-"));
  roots.push(project);
  await mkdir(path.join(project, "index"), { recursive: true });
  await writeFile(path.join(project, PATHS.site), `${JSON.stringify(site, null, 2)}\n`, "utf8");
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
    const actualRuns = (await readJsonl(path.join(project, PATHS.runs))).filter((row) => row.job === "daily");
    const expectedRuns = (await readJsonl(path.join(fixtureDir, "expected", "project", "index", "logs", "runs.jsonl")))
      .filter((row) => row.job === "daily");
    const normalizeRuns = (rows: Record<string, unknown>[]) => rows.map((row) => ({
      ...row, started_at: "<normalized>", finished_at: "<normalized>",
    }));
    expect(normalizeRuns(actualRuns)).toEqual(normalizeRuns(expectedRuns));
  }, 30_000);

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
      const result = await runDaily(project, [snapshot], { date: "2026-10-22", now: fixedNow });
      expect(result.exitCode).toBe(0);
      const [row] = await readJsonl(path.join(project, PATHS.skus));
      expect(row).toMatchObject({ category, category_source: source });
    }
  }, 30_000);
});
