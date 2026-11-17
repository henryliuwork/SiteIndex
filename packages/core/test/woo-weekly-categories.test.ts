import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonl } from "../src/io/jsonl";
import { runWeekly } from "../src/jobs/weekly";

afterEach(() => vi.unstubAllGlobals());

describe("WooCommerce weekly categories", () => {
  it("classifies custom prefixes and encoded category slugs without treating /product/ as a category", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-weekly-"));
    try {
      const project = path.join(root, "demo-project");
      await cp(path.resolve("fixtures/expected/project"), project, { recursive: true });
      const base = "https://shop.example.test";
      const routes: Record<string, string> = {
        "/sitemap.xml": `<urlset>${[
          "/shop/%E5%AE%B6%E5%85%B7/", "/shop/gear/lawn/", "/product-category/outdoor/", "/product/demo/",
        ].map((url) => `<url><loc>${base}${url}</loc></url>`).join("")}</urlset>`,
        "/shop/%E5%AE%B6%E5%85%B7/": "<html><head><title>Demo furniture</title></head><body><main><h1>家具</h1></main></body></html>",
        "/shop/gear/lawn/": "<html><head><title>Demo lawn</title></head><body><main><h1>Lawn</h1></main></body></html>",
        "/product-category/outdoor/": "<html><head><title>Demo outdoor</title></head><body><main><h1>Outdoor</h1></main></body></html>",
        "/product/demo/": "<html><head><title>Demo product</title></head><body><main><h1>Demo product</h1></main></body></html>",
      };
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return new Response(routes[url.pathname] ?? "missing", { status: routes[url.pathname] ? 200 : 404,
          headers: { "content-type": url.pathname.endsWith(".xml") ? "application/xml" : "text/html" } });
      }));
      const config = JSON.parse(await readFile(path.join(project, PATHS.site), "utf8")) as SiteConfig;
      config.base_url = base;
      config.sitemaps = [`${base}/sitemap.xml`];
      config.crawl.rate_limit_ms = 0;
      config.categories = { mode: "url_rule", url_pattern: "/shop/{slug}, /product-category/{slug}" };
      const result = await runWeekly(project, config, { date: "2026-11-17" });
      expect(result.status).toBe("partial");
      expect(result.counts.categories).toBe(3);
      const pages = await readJsonl(path.join(project, PATHS.seoPages));
      expect(pages.map((page) => [new URL(String(page.url)).pathname, page.page_type]))
        .toEqual([["/product-category/outdoor/", "collection"], ["/product/demo/", "product"], ["/shop/%E5%AE%B6%E5%85%B7/", "collection"], ["/shop/gear/lawn/", "collection"]]);
      const categories = JSON.parse(await readFile(path.join(project, PATHS.categories), "utf8")) as { slug: string; parent: string | null }[];
      expect(categories.map((category) => category.slug)).toEqual(["lawn", "outdoor", "家具"]);
      expect(categories.find((category) => category.slug === "lawn")?.parent).toBe("gear");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
