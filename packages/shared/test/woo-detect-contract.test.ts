import { describe, expect, it } from "vitest";
import type { DetectResult } from "../src/api";

const legacy: DetectResult = {
  input: "https://shop.example.test", final_url: "https://shop.example.test/", redirect_status: null,
  robots: { found: false, disallow_count: 0, sitemaps: [] },
  sitemaps: [{ url: "https://shop.example.test/sitemap.xml", type: "index", url_count: 1 }],
  total_urls: 0, platform: "woocommerce", platform_evidence: "synthetic", frontend: null,
  locale: null, currency: null, feed_candidates: [],
};

describe("WooCommerce detection contract", () => {
  it("keeps existing results valid and adds optional sitemap roles and category prefixes", () => {
    const enriched: DetectResult = {
      ...legacy,
      sitemaps: [{ ...legacy.sitemaps[0]!, role: "index" },
        { url: "https://shop.example.test/category-map.xml", type: "urlset", url_count: 2, role: "category" }],
      category_prefix_candidates: ["/collections/"],
    };
    expect(legacy.category_prefix_candidates).toBeUndefined();
    expect(legacy.sitemaps[0]).not.toHaveProperty("role");
    expect(enriched.sitemaps.map((row) => row.role)).toEqual(["index", "category"]);
    expect(enriched.category_prefix_candidates).toEqual(["/collections/"]);
  });
});
