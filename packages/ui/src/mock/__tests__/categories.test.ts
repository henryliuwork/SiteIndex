import { describe, expect, it } from "vitest";
import { createCategoriesMock } from "../categories";
import { projectConfigs } from "../context";

describe("categories mock", () => {
  it("returns unique slugs for the project settings category preview", async () => {
    const result = await createCategoriesMock().preview("demo", projectConfigs.demo.categories);
    const slugs = result.categories.map((category) => category.slug);

    expect(slugs).toEqual(["demo-category-1", "demo-category-2", "demo-category-3", "demo-category-4", "demo-category-5"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses both synthetic URL prefixes for a WooCommerce category preview", async () => {
    const api = createCategoriesMock();
    const both = await api.preview("demo2", { mode: "url_rule", url_pattern: "/shop/{slug}, /product-category/{slug}" });
    expect(both.categories.map((category) => category.slug)).toEqual(["demo-category-1", "demo-category-2"]);
    expect(both.candidates.filter((candidate) => candidate.configured)).toHaveLength(2);
    expect(both.uncategorized).toBe(4);

    const one = await api.preview("demo2", { mode: "url_rule", url_pattern: "/shop/{slug}" });
    expect(one.categories.map((category) => category.slug)).toEqual(["demo-category-1"]);
    expect(one.uncategorized).toBe(8);
  });
});
