import { describe, expect, it } from "vitest";
import { addCategoryUrlRule, categoryUrlRules } from "./category-rules";

describe("category URL rules", () => {
  it("accepts comma-separated prefixes and keeps distinct slug patterns", () => {
    expect(categoryUrlRules("/shop, /product-category/{slug}，/shop/")).toEqual([
      "/shop/{slug}", "/product-category/{slug}",
    ]);
  });

  it("adds a detected candidate without duplicating a selected rule", () => {
    expect(addCategoryUrlRule("/shop/{slug}", "/product-category/{slug}")).toBe("/shop/{slug}, /product-category/{slug}");
    expect(addCategoryUrlRule("/shop/{slug}", "/shop/{slug}")).toBe("/shop/{slug}");
  });
});
