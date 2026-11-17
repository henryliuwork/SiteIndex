import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSiteDetailed } from "../src/projects/detect";

afterEach(() => vi.unstubAllGlobals());

function stubSite(sitemapName: string): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requested.push(url.pathname);
    if (url.pathname === "/") return new Response(`<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed/">
      <link rel="alternate" type="application/rss+xml" href="/comments/feed/">
      <link rel="alternate" type="application/atom+xml" href="/blog/story/feed/">
      <link rel="alternate" type="application/rss+xml" href="/product-category/gear/feed/">
      <link rel="alternate" type="application/rss+xml" href="/products.xml">
      <link rel="alternate" type="application/xml" href="/feed/merchant-products.xml">
      <meta name="generator" content="WooCommerce"></head><body>woocommerce</body></html>`);
    if (url.pathname === sitemapName) return new Response(`<sitemapindex>
      <sitemap><loc>https://shop.example.test/wp-sitemap-posts-post-1.xml</loc></sitemap>
      <sitemap><loc>https://shop.example.test/wp-sitemap-posts-product-1.xml</loc></sitemap>
      <sitemap><loc>https://shop.example.test/wp-sitemap-taxonomies-product_cat-1.xml</loc></sitemap>
    </sitemapindex>`);
    if (url.pathname.includes("product_cat")) return new Response(`<urlset>
      <url><loc>https://shop.example.test/collections/gear/</loc></url>
      <url><loc>https://shop.example.test/collections/home/</loc></url>
    </urlset>`);
    if (url.pathname.includes("product-1")) return new Response('<urlset><url><loc>https://shop.example.test/item/a/</loc></url></urlset>');
    if (url.pathname.includes("post-1")) return new Response('<urlset><url><loc>https://shop.example.test/story/a/</loc></url></urlset>');
    return new Response("missing", { status: 404 });
  }));
  return requested;
}

describe("WooCommerce detection", () => {
  it.each(["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"])("falls back to %s and classifies child maps", async (sitemapName) => {
    const requested = stubSite(sitemapName);
    const detected = await detectSiteDetailed("https://shop.example.test");
    expect(detected.result.platform).toBe("woocommerce");
    expect(detected.result.feed_candidates).toEqual([
      "https://shop.example.test/feed/merchant-products.xml",
      "https://shop.example.test/products.xml",
    ]);
    expect(detected.result.robots.found).toBe(false);
    expect(requested.filter((name) => name === sitemapName)).toHaveLength(1);
    expect(requested.filter((name) => ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"].includes(name))
      .slice(0, ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"].indexOf(sitemapName) + 1))
      .toEqual(["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"].slice(0, ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"].indexOf(sitemapName) + 1));
    expect(detected.sitemapHints.map((hint) => hint.role)).toEqual(["other", "category", "product", "post"]);
    expect(detected.categoryPrefixCandidates).toEqual(["/collections/"]);
    expect(detected.result.total_urls).toBe(4);
  });

  it("prefers a robots.txt sitemap over fallback names", async () => {
    const requested = stubSite("/custom-map.xml");
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/robots.txt") return new Response("Sitemap: https://shop.example.test/custom-map.xml\n");
      return originalFetch(input);
    }));
    const detected = await detectSiteDetailed("https://shop.example.test");
    expect(detected.result.robots.sitemaps[0]).toBe("https://shop.example.test/custom-map.xml");
    expect(requested).not.toContain("/sitemap_index.xml");
  });
});
