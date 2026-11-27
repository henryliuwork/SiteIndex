import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, expect, it, vi } from "vitest";
import { runWeekly } from "../src/jobs/weekly";

const BASE = "http://127.0.0.1:43129";
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.fails("indexes a product URL from an application/x-gzip sitemap without Content-Encoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-gzip-audit-"));
  roots.push(root);
  await mkdir(path.dirname(path.join(root, PATHS.skus)), { recursive: true });
  await writeFile(path.join(root, PATHS.skus), "", "utf8");
  const schedule = { enabled: false, time: "00:00" };
  const config: SiteConfig = {
    schema_version: "1.1", domain: "synthetic.example.test", base_url: BASE,
    platform: "other", currency: "USD", locale: "en-US", timezone: "UTC",
    brand: { name: "Synthetic Catalog" }, sitemaps: [`${BASE}/products.xml.gz`],
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0, max_pages: 20 },
    categories: { mode: "manual", manual: [] }, workspace_folders: [],
    schedule: { daily: schedule, validate: schedule, weekly: schedule, readme: schedule, monthly: schedule,
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } },
  };
  const sitemap = `<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>`;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/products.xml.gz") {
      return new Response(gzipSync(sitemap), { headers: { "content-type": "application/x-gzip" } });
    }
    if (url.pathname === "/products/demo") {
      return new Response("<html><head><title>Demo</title></head><body><h1>Demo</h1></body></html>",
        { headers: { "content-type": "text/html" } });
    }
    throw new Error(`Unexpected synthetic request: ${url.pathname}`);
  }));

  const result = await runWeekly(root, config, { date: "2026-11-27", only: "pages" });
  expect(result.status, JSON.stringify(result)).toBe("ok");
  const pages = (await readFile(path.join(root, PATHS.seoPages), "utf8")).trim().split(/\r?\n/u)
    .filter(Boolean).map((line) => JSON.parse(line) as { url: string });
  expect(pages.map((page) => page.url)).toContain(`${BASE}/products/demo`);
});
