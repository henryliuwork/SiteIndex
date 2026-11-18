import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type CreateProjectInput, type DetectResult, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFiles } from "../src/projects/create";
import { createCoreService } from "../src/service";
import { readJsonl } from "../src/io/jsonl";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WooCommerce automatic daily", () => {
  it("runs init and daily without a Feed, preserves variant relationships and writes real stock/price changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-auto-"));
    roots.push(root);
    const base = "https://shop.example.test";
    const detected: DetectResult = { input: base, final_url: `${base}/`, redirect_status: null,
      robots: { found: true, disallow_count: 0, sitemaps: [`${base}/sitemap.xml`] },
      sitemaps: [], total_urls: 0, platform: "woocommerce", platform_evidence: "test",
      frontend: null, locale: "en-US", currency: "USD", feed_candidates: [] };
    const input: CreateProjectInput = { url: base, feed_urls: [], sku_field: "id", category_depth: 1,
      missing_as: "out_of_stock", brand: { name: "Demo Shop" }, markets: ["US"],
      projects_root: root, folder_name: "demo", workspace_folders: [], auto_collect_products: true,
      categories: { mode: "feed" } };
    const created = await createProjectFiles(input, detected);
    const sitePath = path.join(created.path, PATHS.site);
    const config = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
    config.crawl.rate_limit_ms = 200;
    await writeFile(sitePath, `${JSON.stringify(config)}\n`);
    let secondDay = false;
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
      if (url.pathname.endsWith("/products/categories")) return Response.json([{ id: 7, slug: "garden" }]);
      if (url.pathname.endsWith("/products")) {
        const product = (id: number, sku: string, price: string, parentId?: number) => ({
          id, sku, name: parentId ? `Demo variant ${id}` : "Demo parent", slug: "demo-parent",
          permalink: `${base}/product/demo/`, parent_id: parentId,
          prices: { price, regular_price: "1500", currency_minor_unit: 2, currency_code: "USD" },
          is_in_stock: id !== 12 || secondDay, is_purchasable: true, categories: [{ id: 7 }], images: [],
        });
        return Response.json(url.searchParams.get("type") === "variation"
          ? [product(11, "DEMO-RED", secondDay ? "1300" : "1200", 10), product(12, "DEMO-BLUE", "1400", 10)]
          : [product(10, "DEMO-PARENT", "1500")]);
      }
      if (url.pathname === "/sitemap.xml") return new Response(`<urlset><url><loc>${base}/product/demo/</loc></url></urlset>`);
      if (url.pathname === "/product/demo/") return new Response("<html><h1>Demo product</h1></html>");
      return new Response("missing", { status: 404 });
    }));
    const api = createCoreService({ resolveProject: () => created.path, deviceId: "test-device", cacheDir: path.join(root, "cache") });
    const init = await api.runJob({ projectPath: created.path, job: "init", trigger: "manual", date: "2026-11-17" }, () => undefined);
    expect(init.steps?.find((step) => step.key === "daily")?.status).toBe("ok");
    expect((await readJsonl(path.join(created.path, PATHS.skus))).map((row) => [row.sku, row.parent_sku]))
      .toEqual([["DEMO-BLUE", "DEMO-PARENT"], ["DEMO-RED", "DEMO-PARENT"]]);
    const parentRows = await api.inventory.listSkus("demo", { page: 1, pageSize: 20, filters: { parent_only: true } });
    expect(parentRows.rows).toMatchObject([{ sku: "DEMO-PARENT", is_parent: true, children_count: 2,
      in_stock_children_count: 1 }]);
    const products = await api.products.list("demo", { page: 1, pageSize: 20, filters: { parent_only: true } });
    expect(products.rows).toMatchObject([{ row_kind: "parent", product_id: "DEMO-PARENT", variant_count: 2 }]);
    secondDay = true;
    const daily = await api.runJob({ projectPath: created.path, job: "daily", trigger: "manual", date: "2026-11-18" }, () => undefined);
    expect(daily.status, JSON.stringify(daily)).toBe("ok");
    const events = await readJsonl(path.join(created.path, PATHS.eventsDir, "2026-11.jsonl"));
    expect(events.map((row) => [row.sku, row.type])).toEqual([["DEMO-BLUE", "stock_change"], ["DEMO-RED", "price_change"]]);
    expect(await readFile(path.join(created.path, PATHS.dailySummary), "utf8")).toContain("2026-11-18,_all,2,2");
  }, 60_000);

  it("falls back to a product sitemap and Product JSON-LD when Store API is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-fallback-"));
    roots.push(root);
    const base = "https://catalog.example.test";
    const detected: DetectResult = { input: base, final_url: `${base}/`, redirect_status: null,
      robots: { found: false, disallow_count: 0, sitemaps: [] }, sitemaps: [], total_urls: 0,
      platform: "woocommerce", platform_evidence: "test", frontend: null, locale: "en-US",
      currency: "USD", feed_candidates: [] };
    const created = await createProjectFiles({ url: base, feed_urls: [], sku_field: "id", category_depth: 1,
      missing_as: "out_of_stock", brand: { name: "Demo Catalog" }, markets: ["US"], projects_root: root,
      folder_name: "catalog", workspace_folders: [], auto_collect_products: true }, detected);
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
      if (url.pathname.startsWith("/wp-json/")) return new Response("missing", { status: 404 });
      if (url.pathname === "/sitemap_index.xml") return new Response(`<sitemapindex><sitemap><loc>${base}/product-sitemap.xml</loc></sitemap></sitemapindex>`);
      if (url.pathname === "/product-sitemap.xml") return new Response(`<urlset><url><loc>${base}/product/demo/</loc></url></urlset>`);
      if (url.pathname === "/product/demo/") return new Response(`<script type="application/ld+json">${JSON.stringify({
        "@type": "Product", sku: "DEMO-FALLBACK", name: "Demo item",
        offers: { price: "12.50", priceCurrency: "USD", availability: "https://schema.org/InStock" },
      })}</script>`);
      return new Response("missing", { status: 404 });
    }));
    const api = createCoreService({ resolveProject: () => created.path, deviceId: "test-device", cacheDir: path.join(root, "cache") });
    const daily = await api.runJob({ projectPath: created.path, job: "daily", trigger: "manual", date: "2026-11-17" }, () => undefined);
    expect(daily.status, JSON.stringify(daily)).toBe("ok");
    expect((await readJsonl(path.join(created.path, PATHS.skus))).map((row) => [row.sku, row.price]))
      .toEqual([["DEMO-FALLBACK", 12.5]]);
  }, 60_000);
});
