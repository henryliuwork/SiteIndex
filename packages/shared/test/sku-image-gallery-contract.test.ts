import { describe, expect, it } from "vitest";
import type { SkuImageRow } from "../src";

describe("EDM SKU image contract", () => {
  const base: SkuImageRow = {
    sku: "DEMO-001", title: "Demo item", variant_title: null, stock_status: "in_stock",
    feed_image_url: "https://shop.example.test/media/main.jpg", manual_image_url: null, used: "feed",
  };

  it("preserves older rows and serializes the optional full gallery", () => {
    const legacy: SkuImageRow = { ...base };
    const gallery: SkuImageRow = { ...base, gallery_urls: [
      "https://shop.example.test/media/main.jpg", "https://shop.example.test/media/side.jpg",
    ] };
    expect(JSON.parse(JSON.stringify(legacy))).not.toHaveProperty("gallery_urls");
    expect(JSON.parse(JSON.stringify(gallery))).toMatchObject({
      feed_image_url: base.feed_image_url, gallery_urls: gallery.gallery_urls,
    });
  });
});
