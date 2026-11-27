import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWeekly } from "../src/jobs/weekly";

const BASE = "http://127.0.0.1:43123";
const roots: string[] = [];

interface Route {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

function stubRoutes(routes: Map<string, Route>): ReturnType<typeof vi.fn> {
  const requests = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1") throw new Error(`Unexpected request host: ${url.hostname}`);
    const route = routes.get(url.pathname) ?? { body: "not found", status: 404 };
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers });
  });
  vi.stubGlobal("fetch", requests);
  return requests;
}

function config(): SiteConfig {
  const schedule = { enabled: false, time: "00:00" };
  return {
    schema_version: "1.1", domain: "synthetic.example.test", base_url: BASE,
    platform: "other", currency: "USD", locale: "en-US", timezone: "UTC",
    brand: { name: "Synthetic Catalog" }, sitemaps: [`${BASE}/sitemap.xml`],
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0, max_pages: 20 },
    categories: { mode: "manual", manual: [] }, workspace_folders: [],
    schedule: { daily: schedule, validate: schedule, weekly: schedule, readme: schedule, monthly: schedule,
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } },
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-audit-"));
  roots.push(root);
  await mkdir(path.dirname(path.join(root, PATHS.skus)), { recursive: true });
  await mkdir(path.dirname(path.join(root, PATHS.seoPages)), { recursive: true });
  await writeFile(path.join(root, PATHS.skus), "", "utf8");
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("weekly crawl audit characterization", () => {
  it.fails("reports a sitemap branch skipped beyond depth five with a count, reason, and non-ok state", async () => {
    const routes = new Map<string, Route>();
    routes.set("/sitemap.xml", { body: `<sitemapindex><sitemap><loc>${BASE}/depth-1.xml</loc></sitemap><sitemap><loc>${BASE}/known.xml</loc></sitemap></sitemapindex>` });
    for (let depth = 1; depth <= 5; depth += 1) {
      routes.set(`/depth-${depth}.xml`, { body: `<sitemapindex><sitemap><loc>${BASE}/depth-${depth + 1}.xml</loc></sitemap></sitemapindex>` });
    }
    routes.set("/known.xml", { body: `<urlset><url><loc>${BASE}/products/known</loc></url></urlset>` });
    routes.set("/depth-6.xml", { body: `<urlset><url><loc>${BASE}/products/deep</loc></url></urlset>` });
    routes.set("/products/known", { body: "<html><head><title>Known</title></head><body><main><h1>Known</h1></main></body></html>" });
    const requests = stubRoutes(routes);
    const root = await project();

    const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
    const rows = JSON.parse(`[${(await readFile(path.join(root, PATHS.seoPages), "utf8")).trim().replace(/\n/gu, ",")}]`) as Array<Record<string, unknown>>;

    const violations: string[] = [];
    if (result.status === "ok") violations.push("weekly status stayed ok after a branch was skipped");
    if (result.counts.sitemap_depth_skipped !== 1) violations.push("counts.sitemap_depth_skipped was not 1");
    if (!result.errors.some((error) => /sitemap.*depth|sitemap.*嵌套深度/iu.test(error))) violations.push("no readable sitemap depth reason was reported");
    expect(violations).toEqual([]);
    expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain("/depth-6.xml");
    expect(rows.map((row) => row.url)).toEqual([`${BASE}/products/known`]);
  });

  it.fails("reports a page HTTP 429 as a crawl failure", async () => {
    const routes = new Map<string, Route>([
      ["/sitemap.xml", { body: `<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>` }],
      ["/products/demo", { body: "rate limited", status: 429 }],
    ]);
    stubRoutes(routes);
    const root = await project();

    const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });

    expect(result.status).not.toBe("ok");
    expect(result.errors.join(" ")).toMatch(/429/u);
  });

  it.fails("preserves the previous SEO row after a page HTTP 429", async () => {
    const routes = new Map<string, Route>([
      ["/sitemap.xml", { body: `<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>` }],
      ["/products/demo", { body: "rate limited", status: 429 }],
    ]);
    stubRoutes(routes);
    const root = await project();
    const previous = { url: `${BASE}/products/demo`, title: "Previous successful title", status_code: 200 };
    await writeFile(path.join(root, PATHS.seoPages), `${JSON.stringify(previous)}\n`, "utf8");

    await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
    const rows = (await readFile(path.join(root, PATHS.seoPages), "utf8")).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(rows).toEqual([previous]);
  });

});
