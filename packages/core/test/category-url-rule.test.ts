import { describe, expect, it } from "vitest";
import { categorySlugForUrl } from "../src/jobs/category-url-rule";

describe("category URL rules", () => {
  it("matches comma-separated custom prefixes in their configured order", () => {
    const rules = "/shop/{slug}, /product-category/{slug}, /custom/departments/{slug}";
    expect(categorySlugForUrl("https://shop.example.test/product-category/outdoor/", rules)).toBe("outdoor");
    expect(categorySlugForUrl("https://shop.example.test/custom/departments/garden/", rules)).toBe("garden");
    expect(categorySlugForUrl("https://shop.example.test/product/demo/", rules)).toBeNull();
  });

  it("decodes non-ASCII slugs and accepts a legacy prefix without the placeholder", () => {
    expect(categorySlugForUrl("https://shop.example.test/shop/%E5%AE%B6%E5%85%B7/", "/shop/{slug}"))
      .toBe("家具");
    expect(categorySlugForUrl("https://shop.example.test/product-category/%E6%88%B7%E5%A4%96/", "/product-category/"))
      .toBe("户外");
  });
});
