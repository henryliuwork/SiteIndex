import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWooStoreApi } from "../src/crawl/woo-store-api";

const site = { base_url: "https://shop.example.test/", currency: "USD" };

afterEach(() => vi.unstubAllGlobals());

function mockStore(noPrices = false): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requested.push(`${url.pathname}${url.search}`);
    const page = url.searchParams.get("page");
    const variation = url.searchParams.get("type") === "variation";
    const product = (id: number, sku: string, price: string | null) => ({
      id, sku, name: `Demo ${id}`, slug: `demo-${id}`, permalink: `https://shop.example.test/product/demo-${id}/`,
      prices: { price, regular_price: "1500", currency_minor_unit: 2, currency_code: "USD" },
      is_in_stock: true, is_purchasable: true, images: [{ src: `https://shop.example.test/images/${id}.jpg` }],
      categories: [{ id: 7 }],
    });
    if (url.pathname.endsWith("/products/categories")) {
      return Response.json(page === "1" ? [{ id: 7, slug: "garden" }] : [{ id: 8, slug: "indoor" }],
        { headers: { "x-wp-totalpages": "2" } });
    }
    if (variation) return Response.json([
      { ...product(11, "DEMO-A-RED", noPrices ? null : "1250"), parent_id: 10,
        variation: "Red", is_on_backorder: true },
      { ...product(12, "DEMO-A-BLUE", noPrices ? null : "1300"),
        _links: { up: [{ href: "https://shop.example.test/wp-json/wc/store/v1/products/10" }] } },
      { ...product(13, "DEMO-A-UNPRICED", null), parent_id: 10 },
    ], { headers: { "x-wp-totalpages": "1" } });
    if (page === "1") return Response.json([
      { ...product(10, "DEMO-A", "1500"), name: "Demo Parent", slug: "demo-parent" },
    ], { headers: { "x-wp-totalpages": "2" } });
    return Response.json([{ ...product(20, "DEMO-SINGLE", noPrices ? null : "2500"), is_in_stock: false,
      categories: [{ id: 8 }] }],
      { headers: { "x-wp-totalpages": "2" } });
  }));
  return requested;
}

describe("WooCommerce Store API snapshot", () => {
  it("paginates products and categories, maps variants without a parent stock entity, and skips unpriced rows", async () => {
    const requested = mockStore();
    const result = await collectWooStoreApi(site);
    expect(requested).toContain("/wp-json/wc/store/v1/products?page=2&per_page=100");
    expect(requested).toContain("/wp-json/wc/store/v1/products/categories?page=2&per_page=100");
    expect(requested).toContain("/wp-json/wc/store/v1/products?page=1&per_page=100&type=variation");
    expect(result.rows.map((row) => row.sku)).toEqual(["DEMO-A-BLUE", "DEMO-A-RED", "DEMO-SINGLE"]);
    expect(result.rows[0]).toMatchObject({ product_id: "10", parent_sku: "DEMO-A", category: "garden" });
    expect(result.rows[1]).toMatchObject({
      product_id: "10", parent_sku: "DEMO-A", handle: "demo-parent", variant_title: "Red",
      category: "garden", categories: ["garden"], price: 12.5, compare_at_price: 15,
      stock_status: "preorder", image_url: "https://shop.example.test/images/11.jpg",
    });
    expect(result.rows[2]).toMatchObject({ product_id: "20", category: "indoor", price: 25, stock_status: "out_of_stock" });
    expect(result.filtered).toEqual({ no_id: 0, duplicate: 0, missing_price_or_link: 1, missing_price: 1, missing_link: 0 });
    expect(result.emptyReason).toBeNull();
    expect(result.warnings).toEqual(["1 条商品缺少有效价格，已跳过；询价商品暂未入库。"]);
  });

  it("reports a Chinese reason when every product is unpriced, without inventing zero prices", async () => {
    mockStore(true);
    const result = await collectWooStoreApi(site);
    expect(result.rows).toEqual([]);
    expect(result.filtered.missing_price).toBe(4);
    expect(result.emptyReason).toContain("缺少有效价格");
  });

  it("fails with a structured source error when the product endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 404 })));
    await expect(collectWooStoreApi(site)).rejects.toMatchObject({ code: "FEED_FETCH_FAILED" });
  });
});
