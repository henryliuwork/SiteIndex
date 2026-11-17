import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMissingStock, type StockVerificationSite } from "../src/jobs/stock-verifier";

const site: StockVerificationSite = {
  base_url: "https://shop.example.test/", platform: "woocommerce",
  crawl: { rate_limit_ms: 0, stock_verify: { enabled: true, max_per_run: 2 } },
};
afterEach(() => vi.unstubAllGlobals());

describe("WooCommerce missing-stock verification", () => {
  it("uses an exact Store API SKU status and falls back to page JSON-LD when the API is unavailable", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requested.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/product/a/") return new Response("<html><h1>Demo A</h1></html>");
      if (url.pathname === "/product/b/") return new Response(`<html><script type="application/ld+json">
        {"@type":"Product","sku":"DEMO-B","offers":{"availability":"PreOrder"}}</script></html>`);
      if (url.pathname.endsWith("/products") && url.searchParams.get("sku") === "DEMO-A") {
        return Response.json([{ sku: "DEMO-A", is_in_stock: false }]);
      }
      return new Response("unavailable", { status: 403 });
    }));
    const batch = await verifyMissingStock([
      { sku: "DEMO-A", url: "https://shop.example.test/product/a/" },
      { sku: "DEMO-B", url: "https://shop.example.test/product/b/" },
    ], site, { wait: async () => undefined });
    expect(batch.results.get("DEMO-A")).toEqual({ kind: "status", status: "out_of_stock" });
    expect(batch.results.get("DEMO-B")).toEqual({ kind: "status", status: "preorder" });
    expect(requested).toContain("/wp-json/wc/store/v1/products?sku=DEMO-A&per_page=1");
    expect(requested).toContain("/wp-json/wc/store/v1/products?sku=DEMO-B&per_page=1");
    expect(batch.unavailable).toBe(0);
  });
});
