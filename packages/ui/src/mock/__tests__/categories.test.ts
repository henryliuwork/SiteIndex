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
});
