import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PATHS } from "@siteindex/shared";
import { toSnapshot, type FeedItem, type FeedSiteConfig } from "../src/crawl/gmc-feed";
import { runDaily } from "../src/jobs/daily";
import { buildViews } from "../src/views/build";

const SKU_COUNT = 10_000;
const LIMIT_MS = 30_000;
const BENCH_DATE = "2026-10-26";
const NOW = new Date(`${BENCH_DATE}T12:00:00.000Z`);

function syntheticFeed(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) => {
    const sku = `BENCH-${String(index + 1).padStart(5, "0")}`;
    return {
      id: sku,
      item_group_id: sku,
      title: `Synthetic product ${index + 1}`,
      link: `https://bench.example/products/${sku.toLowerCase()}`,
      price: `${15 + index % 85}.99 USD`,
      availability: index % 5 === 0 ? "out of stock" : "in stock",
      quantity: index % 5 === 0 ? "0" : String((index % 20) + 1),
      image_link: `https://bench.example/images/${sku.toLowerCase()}.jpg`,
      product_type: `Benchmark > Category ${String(index % 20).padStart(2, "0")}`,
      brand: "SiteIndex Synthetic",
    };
  });
}

async function main(): Promise<void> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "siteindex-daily-bench-"));
  try {
    await mkdir(path.dirname(path.join(projectPath, PATHS.site)), { recursive: true });
    const site: FeedSiteConfig & Record<string, unknown> = {
      schema_version: "1.1",
      domain: "bench.example",
      base_url: "https://bench.example",
      currency: "USD",
      timezone: "UTC",
      crawl: {
        feed_url: "synthetic://10k",
        sku_field: "id",
        category_source: "product_type",
        category_depth: 2,
        missing_as: "removed",
      },
      categories: { mode: "feed" },
    };
    await writeFile(path.join(projectPath, PATHS.site), `${JSON.stringify(site, null, 2)}\n`, "utf8");

    const feed = syntheticFeed(SKU_COUNT);
    const startedAt = performance.now();
    const snapshot = toSnapshot(feed, site, BENCH_DATE);
    if (snapshot.rows.length !== SKU_COUNT) {
      throw new Error(`预期 ${SKU_COUNT} 个 SKU，实际解析出 ${snapshot.rows.length} 个。`);
    }
    const daily = await runDaily(projectPath, snapshot.rows, { date: BENCH_DATE, now: NOW });
    if (daily.status === "failed") throw new Error(daily.errors.join("\n") || "daily 执行失败。");
    const views = await buildViews(projectPath, { date: BENCH_DATE, now: NOW });
    const elapsedMs = performance.now() - startedAt;
    const elapsedSeconds = (elapsedMs / 1000).toFixed(2);

    process.stdout.write([
      `Daily 10,000 SKU: ${elapsedSeconds}s (${elapsedMs.toFixed(0)} ms)`,
      `snapshot=${snapshot.rows.length}, active=${daily.counts.active}, products=${views.products}, sku_stock=${views.skuStock}`,
      `download=excluded, target=<${LIMIT_MS / 1000}s`,
      elapsedMs < LIMIT_MS ? "PASS" : "FAIL",
    ].join("\n") + "\n");
    if (elapsedMs >= LIMIT_MS) process.exitCode = 1;
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
