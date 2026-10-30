import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SiteConfig } from "@siteindex/shared";
import { invalidateInventoryForCategoryChange } from "./inventory-cache";

const categories: SiteConfig["categories"] = {
  mode: "feed",
  watched: [{ name: "Bird Feeders", slug: "bird-feeders", manual: false }],
};

describe("关注分类缓存刷新", () => {
  it("分类配置有变化时失效库存摘要与列表", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    await invalidateInventoryForCategoryChange(queryClient, "demo", categories, {
      ...categories,
      watched: [],
    });

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory-summary", "demo"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory-skus", "demo"] });
  });

  it("分类配置不变时不触碰库存缓存", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    await invalidateInventoryForCategoryChange(queryClient, "demo", categories, structuredClone(categories));

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("设置页保存分类配置后调用库存缓存失效", () => {
    const source = readFileSync(new URL("../ProjectSettingsConfigPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("invalidateInventoryForCategoryChange(queryClient, id, previousCategories, saved.categories)");
  });
});
