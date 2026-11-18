import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type Category, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonl } from "../src/io/jsonl";
import { runWeekly } from "../src/jobs/weekly";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WooCommerce weekly categories and SEO URLs", () => {
  it.each([
    { apiStatus: 200, sitemap: true }, { apiStatus: 403, sitemap: true }, { apiStatus: 200, sitemap: false },
  ])("builds categories before daily (API $apiStatus, sitemap $sitemap)", async ({ apiStatus, sitemap }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-weekly-v064-"));
    roots.push(root);
    const project = path.join(root, "demo");
    await cp(path.resolve("fixtures/expected/project"), project, { recursive: true });
    await writeFile(path.join(project, PATHS.skus), "");
    const fixture = path.resolve("fixtures/woocommerce-v065");
    const routes = JSON.parse(await readFile(path.join(fixture, "routes.json"), "utf8")) as
      { scenario: string; path: string; body: string; content_type: string }[];
    const base = "https://shop.example.test";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const route = routes.find((item) => item.path === url.pathname &&
        (item.scenario === "site" || item.scenario === "store_api" && url.pathname.endsWith("/categories")));
      if (!route) return new Response("missing", { status: 404 });
      if (apiStatus === 403 && url.pathname.endsWith("/categories")) return new Response("forbidden", { status: 403 });
      let body = await readFile(path.join(fixture, route.body), "utf8");
      if (apiStatus === 403 && url.pathname === "/product/sample-lamp/") body += "<div class='product_cat-special'></div>";
      return new Response(body, { headers: { "content-type": route.content_type } });
    }));
    const config = JSON.parse(await readFile(path.join(project, PATHS.site), "utf8")) as SiteConfig;
    config.base_url = base;
    config.platform = "woocommerce";
    config.sitemaps = sitemap ? [`${base}/sitemap_index.xml`] : [];
    config.crawl.rate_limit_ms = 0;
    config.categories = { mode: "url_rule", url_pattern: "/shop/{slug}, /gear/{slug}" };
    const result = await runWeekly(project, config, { date: "2026-11-18" });
    expect(result.counts.categories, JSON.stringify(result)).toBeGreaterThanOrEqual(3);
    const categories = JSON.parse(await readFile(path.join(project, PATHS.categories), "utf8")) as Category[];
    expect(categories.map((item) => item.slug)).toContain("lighting");
    expect(categories.find((item) => item.slug === "lighting")?.parent).toBe("catalog");
    if (apiStatus === 200) {
      expect(categories.find((item) => item.slug === "outdoor")?.parent).toBe("catalog");
      expect(categories.find((item) => item.slug === "catalog")?.product_count).toBe(3);
    } else {
      expect(categories.map((item) => item.slug)).toContain("special");
      expect(categories.find((item) => item.slug === "lighting")?.product_count).toBeUndefined();
    }
    if (sitemap) {
      const pages = await readJsonl(path.join(project, PATHS.seoPages));
      expect(pages.filter((page) => String(page.url).includes("/product/sample-lamp/"))).toHaveLength(1);
      expect(pages.some((page) => String(page.url).includes("attribute_pa_"))).toBe(false);
      const links = await readJsonl(path.join(project, PATHS.seoLinks));
      expect(links.some((link) => String(link.to).includes("attribute_pa_"))).toBe(false);
      const blogs = await readJsonl(path.join(project, PATHS.blogIndex));
      expect(blogs.map((row) => row.slug)).toContain("sample-post");
    }
  }, 30_000);
});
