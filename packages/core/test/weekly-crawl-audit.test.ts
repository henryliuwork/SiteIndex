import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWeekly } from "../src/jobs/weekly";
import { createCoreService } from "../src/service";

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
  it("reports a sitemap branch skipped beyond depth five with a count, reason, and non-ok state", async () => {
    const knownPages = Array.from({ length: 5 }, (_, index) => `${BASE}/products/known-${index + 1}`);
    const routes = new Map<string, Route>();
    routes.set("/sitemap.xml", { body: `<sitemapindex><sitemap><loc>${BASE}/depth-1.xml</loc></sitemap><sitemap><loc>${BASE}/known.xml</loc></sitemap></sitemapindex>` });
    for (let depth = 1; depth <= 5; depth += 1) {
      routes.set(`/depth-${depth}.xml`, { body: `<sitemapindex><sitemap><loc>${BASE}/depth-${depth + 1}.xml</loc></sitemap></sitemapindex>` });
    }
    routes.set("/known.xml", { body: `<urlset>${knownPages.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>` });
    routes.set("/depth-6.xml", { body: `<urlset><url><loc>${BASE}/products/deep</loc></url></urlset>` });
    for (const url of knownPages) routes.set(new URL(url).pathname,
      { body: "<html><head><title>Known</title></head><body><main><h1>Known</h1></main></body></html>" });
    const requests = stubRoutes(routes);
    const root = await project();

    const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
    const rows = JSON.parse(`[${(await readFile(path.join(root, PATHS.seoPages), "utf8")).trim().replace(/\n/gu, ",")}]`) as Array<Record<string, unknown>>;

    expect(result.status).toBe("partial");
    expect(result.counts.sitemap_depth_skipped).toBe(1);
    expect(result.errors.some((error) => /sitemap.*depth|sitemap.*嵌套深度/iu.test(error))).toBe(true);
    expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain("/depth-6.xml");
    expect(rows.map((row) => row.url)).toEqual(knownPages);
  });

  it("reports a page HTTP 429 as a crawl failure", async () => {
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

  it("preserves the previous SEO row when a page HTTP 429 occurs in an otherwise successful crawl", async () => {
    const successfulPages = Array.from({ length: 5 }, (_, index) => `${BASE}/products/ok-${index + 1}`);
    const routes = new Map<string, Route>([
      ["/sitemap.xml", { body: `<urlset>${[`/products/demo`, ...successfulPages.map((url) => new URL(url).pathname)]
        .map((pathname) => `<url><loc>${BASE}${pathname}</loc></url>`).join("")}</urlset>` }],
      ["/products/demo", { body: "rate limited", status: 429 }],
      ...successfulPages.map((url) => [new URL(url).pathname, { body: `<html><head><title>${new URL(url).pathname}</title></head><body><main><h1>Product</h1></main></body></html>` }] as const),
    ]);
    stubRoutes(routes);
    const root = await project();
    const previous = { url: `${BASE}/products/demo`, title: "Previous successful title", status_code: 200 };
    await writeFile(path.join(root, PATHS.seoPages), `${JSON.stringify(previous)}\n`, "utf8");

    const result = await runWeekly(root, config(), { date: "2026-11-27", only: "pages" });
    const rows = (await readFile(path.join(root, PATHS.seoPages), "utf8")).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(rows).toEqual([previous]);
    expect(result).toMatchObject({ status: "failed", counts: {} });
    expect(result.errors.join(" ")).toMatch(/429/u);
  });

  it("records an HTTP 429 as a failed weekly run", async () => {
    stubRoutes(new Map<string, Route>([
      ["/sitemap.xml", { body: `<urlset><url><loc>${BASE}/products/demo</loc></url></urlset>` }],
      ["/products/demo", { body: "rate limited", status: 429 }],
    ]));
    const root = await project();
    await writeFile(path.join(root, PATHS.site), `${JSON.stringify(config())}\n`, "utf8");
    const service = createCoreService({ resolveProject: () => root, deviceId: "synthetic-device",
      cacheDir: path.join(root, "cache") });

    const result = await service.runJob({ projectPath: root, job: "weekly", trigger: "manual", date: "2026-11-27" }, () => undefined);
    const run = (await readFile(path.join(root, PATHS.runs), "utf8")).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>)[0];

    expect(result).toMatchObject({ status: "failed", errors: [expect.stringContaining("429")] });
    expect(run).toMatchObject({ job: "weekly", status: "failed", errors: [expect.stringContaining("429")] });
  });

});
