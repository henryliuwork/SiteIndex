import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteConfig } from "@siteindex/shared";
import { collectWooSitemapHtml } from "../src/crawl/woo-sitemap-html";

const site: Pick<SiteConfig, "base_url" | "currency" | "sitemaps" | "crawl"> = {
  base_url: "https://shop.example.test/", currency: "USD", sitemaps: ["https://shop.example.test/sitemap_index.xml"],
  crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0 },
};
afterEach(() => vi.unstubAllGlobals());

describe("WooCommerce Sitemap and HTML fallback", () => {
  it("uses the product child sitemap, Product JSON-LD and WooCommerce DOM while skipping unpriced products", async () => {
    const requested: string[] = [];
    const pages: Record<string, string> = {
      "/sitemap_index.xml": `<sitemapindex>
        <sitemap><loc>https://shop.example.test/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://shop.example.test/product-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      "/product-sitemap.xml": `<urlset>${["a", "b", "unpriced"].map((slug) =>
        `<url><loc>https://shop.example.test/product/${slug}/</loc></url>`).join("")}</urlset>`,
      "/product/a/": `<html><head><script type="application/ld+json">{"@graph":[{"@type":"Product",
        "sku":"DEMO-A","name":"Demo A","category":"Garden","image":"https://cdn.example.test/a.jpg",
        "offers":{"@type":"Offer","price":"12.50","priceCurrency":"USD","availability":"InStock"}}]}</script></head></html>`,
      "/product/b/": `<html><body><h1 class="product_title">Demo B</h1><span class="sku">DEMO-B</span>
        <span class="price">$18.50</span><p class="stock out-of-stock">Unavailable</p></body></html>`,
      "/product/unpriced/": `<html><script type="application/ld+json">{"@type":"Product","sku":"DEMO-C",
        "name":"Demo C","offers":{"@type":"Offer","availability":"PreOrder"}}</script></html>`,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      requested.push(path);
      return new Response(pages[path] ?? "missing", { status: pages[path] ? 200 : 404 });
    }));
    const result = await collectWooSitemapHtml(site);
    expect(requested).not.toContain("/post-sitemap.xml");
    expect(result.rows.map((row) => row.sku)).toEqual(["DEMO-A", "DEMO-B"]);
    expect(result.rows[0]).toMatchObject({ price: 12.5, stock_status: "in_stock", category: "garden",
      image_url: "https://cdn.example.test/a.jpg" });
    expect(result.rows[1]).toMatchObject({ price: 18.5, stock_status: "out_of_stock" });
    expect(result.filtered.missing_price_or_link).toBe(1);
    expect(result.warnings[0]).toContain("缺少有效价格");
  });

  it("fails without returning a partial snapshot when a product page request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      return path.endsWith(".xml")
        ? new Response("<urlset><url><loc>https://shop.example.test/product/a/</loc></url></urlset>")
        : new Response("unavailable", { status: 503 });
    }));
    await expect(collectWooSitemapHtml(site)).rejects.toMatchObject({ code: "FEED_FETCH_FAILED" });
  });
});
