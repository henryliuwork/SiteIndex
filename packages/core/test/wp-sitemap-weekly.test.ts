import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonl } from "../src/io/jsonl";
import { runWeekly } from "../src/jobs/weekly";
import { detectSiteDetailed } from "../src/projects/detect";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WordPress Sitemap discovery through Weekly", () => {
  it("uses wp-sitemap.xml when robots and sitemap_index.xml are absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-wp-map-"));
    roots.push(root);
    const project = path.join(root, "demo");
    await cp(path.resolve("fixtures/expected/project"), project, { recursive: true });
    const base = "https://shop.example.test";
    const requests: string[] = [];
    const pages: Record<string, string> = {
      "/": '<html><body class="woocommerce">Demo shop</body></html>',
      "/wp-sitemap.xml": `<sitemapindex><sitemap><loc>${base}/wp-sitemap-posts-product-1.xml</loc></sitemap>
        <sitemap><loc>${base}/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>`,
      "/wp-sitemap-posts-product-1.xml": `<urlset><url><loc>${base}/product/demo-item/</loc></url></urlset>`,
      "/wp-sitemap-posts-post-1.xml": `<urlset><url><loc>${base}/journal/demo-post/</loc></url></urlset>`,
      "/product/demo-item/": `<html><head><title>Demo item</title>
        <script type="application/ld+json">{"@type":"Product","name":"Demo item"}</script></head>
        <body><h1>Demo item</h1><a href="/journal/demo-post/">Article</a></body></html>`,
      "/journal/demo-post/": `<html><head><title>Demo post</title>
        <script type="application/ld+json">{"@type":"BlogPosting","headline":"Demo post"}</script></head>
        <body class="single-post"><article><h1>Demo post</h1><a href="/product/demo-item/">Product</a></article></body></html>`,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push(url.pathname);
      return new Response(pages[url.pathname] ?? "missing", { status: pages[url.pathname] ? 200 : 404 });
    }));
    const detected = await detectSiteDetailed(base);
    expect(detected.result.robots.found).toBe(false);
    expect(requests).toContain("/sitemap_index.xml");
    expect(detected.result.robots.sitemaps).toContain(`${base}/wp-sitemap.xml`);
    expect(requests).not.toContain("/sitemap.xml");

    const config = JSON.parse(await readFile(path.join(project, PATHS.site), "utf8")) as SiteConfig;
    config.base_url = base;
    config.platform = detected.result.platform;
    config.sitemaps = detected.result.robots.sitemaps;
    config.categories = { mode: "feed" };
    config.crawl.rate_limit_ms = 0;
    const weekly = await runWeekly(project, config, { date: "2026-11-18" });
    expect(weekly.counts.pages, JSON.stringify(weekly)).toBe(2);
    expect(weekly.counts.blog).toBe(1);
    expect((await readJsonl(path.join(project, PATHS.blogIndex))).map((row) => row.slug)).toEqual(["demo-post"]);
    expect((await readJsonl(path.join(project, PATHS.productDetails))).map((row) => row.handle)).toEqual(["demo-item"]);
  }, 30_000);
});
