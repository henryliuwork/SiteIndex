import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InventorySummary, WatchedCategory } from "@siteindex/shared";
import { selectInventoryCategoryRates } from "./categories";

const summary: InventorySummary = {
  as_of: "2026-10-30",
  kpis: [],
  trend: { dates: ["2026-10-30"], series: [] },
  category_rates: [
    { category: "bird-feeders", rate: 0.75, total: 8, watched: true, manual: false },
    { category: "manual-empty", rate: 0, total: 0, watched: true, manual: true },
    { category: "bird-houses", rate: 0.5, total: 4, watched: false, manual: false },
  ],
  category_source: "feed",
  uncategorized: 0,
  today: [],
};

const watchedCategories: WatchedCategory[] = [
  { name: "Bird Feeders", slug: "bird-feeders" },
  { name: "No Inventory Yet", slug: "not-in-summary", manual: true },
];

describe("库存页关注分类数据", () => {
  it("只显示 Core 返回的分类，并按 Core 标记关注与手动分类", () => {
    const categories = selectInventoryCategoryRates(summary, watchedCategories, false);

    expect(categories).toEqual([
      { ...summary.category_rates[0], watched: true, manual: false, label: "Bird Feeders" },
      { ...summary.category_rates[1], watched: true, manual: true, label: "manual-empty" },
    ]);
    expect(categories.some((item) => item.category === "not-in-summary")).toBe(false);
  });

  it("展示默认分类时保留全部 Core 返回项及其标记", () => {
    const categories = selectInventoryCategoryRates(summary, watchedCategories, true);

    expect(categories.map(({ category, watched, manual }) => ({ category, watched, manual }))).toEqual([
      { category: "bird-feeders", watched: true, manual: false },
      { category: "manual-empty", watched: true, manual: true },
      { category: "bird-houses", watched: false, manual: false },
    ]);
  });

  it("库存页将仅关注分类作为 API 筛选条件并为无数据返回空状态", () => {
    const source = readFileSync(new URL("../InventoryPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("api.inventory.listSkus(id, query)");
    expect(source).toContain("watched_only: checked || undefined");
    expect(source).toContain("item.total > 0 ? <span className=\"si-category-track\"");
    expect(source).toContain("关注分类中没有符合当前筛选条件的 SKU。");
    expect(source).not.toMatch(/categoryMap\.set\([^\n]*rate:\s*0/);
  });
});
