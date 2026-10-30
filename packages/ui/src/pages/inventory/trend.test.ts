import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InventorySummary } from "@siteindex/shared";
import { DEFAULT_TREND_CATEGORY_LIMIT, MAX_TREND_CATEGORY_LIMIT, defaultTrendCategories, toggleTrendCategory, trendPoints } from "./trend";

function createSummary(dateCount: number, categoryCount: number, watched: readonly string[] = []): InventorySummary {
  const dates = Array.from({ length: dateCount }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
  const categories = Array.from({ length: categoryCount }, (_, index) => `category-${String(index + 1).padStart(2, "0")}`);
  return {
    as_of: dates.at(-1) ?? "2026-10-30",
    kpis: [],
    trend: { dates, series: categories.map((category, categoryIndex) => ({ category, rates: dates.map((_, dayIndex) => dayIndex === categoryIndex ? null : (categoryIndex + 1) / 100) })) },
    category_rates: categories.map((category) => ({ category, rate: 0.5, total: 10, watched: watched.includes(category), manual: false })),
    category_source: "feed",
    uncategorized: 0,
    today: [],
  };
}

describe("库存趋势图分类与真实日期", () => {
  it("默认最多选三类，并优先展示关注分类", () => {
    const summary = createSummary(30, 30, ["category-20", "category-03", "category-12", "category-01"]);

    expect(defaultTrendCategories(summary)).toEqual(["category-01", "category-03", "category-12"]);
    expect(defaultTrendCategories(summary)).toHaveLength(DEFAULT_TREND_CATEGORY_LIMIT);
  });

  it("无分类时默认不选择任何曲线", () => {
    expect(defaultTrendCategories(createSummary(0, 0))).toEqual([]);
  });

  it("无业务日期时不生成图表点", () => {
    expect(trendPoints(createSummary(0, 3), ["category-01"])).toEqual([]);
  });

  it("单日、两日和三十日都只生成 Core 返回的业务日期点", () => {
    for (const dateCount of [1, 2, 30]) {
      const summary = createSummary(dateCount, 3);
      const points = trendPoints(summary, ["category-01"]);

      expect(points).toHaveLength(dateCount);
      expect(points.map((point) => point.day)).toEqual(datesAsLabels(summary.trend.dates));
    }
  });

  it("不为无历史值的日期补零", () => {
    const summary = createSummary(2, 1);

    expect(trendPoints(summary, ["category-01"])).toEqual([
      { day: "10-01", "category-01": null },
      { day: "10-02", "category-01": 0.01 },
    ]);
  });

  it("支持最多五条曲线，可移除并拒绝第六条", () => {
    const five = Array.from({ length: MAX_TREND_CATEGORY_LIMIT }, (_, index) => `category-${String(index + 1).padStart(2, "0")}`);

    expect(toggleTrendCategory(five.slice(0, 4), "category-05")).toEqual(five);
    expect(toggleTrendCategory(five, "category-06")).toEqual(five);
    expect(toggleTrendCategory(five, "category-03")).toEqual(["category-01", "category-02", "category-04", "category-05"]);
  });

  it("页面按真实日期数量显示单日提示并将图例放在绘图区外", () => {
    const source = readFileSync(new URL("../InventoryPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("hasNoDates ? <p className=\"si-inventory-trend-empty\"");
    expect(source).toContain("目前仅有 1 个业务日期，后续每日同步自动形成趋势。");
    expect(source).toContain("dot={hasOneDate ? { r: 3 } : false}");
    expect(source).toContain("connectNulls={false}");
    expect(source).toContain("si-inventory-trend-legend");
    expect(source).toContain("summary.trend.series.filter((series) => selected.has(series.category))");
    expect(source).toContain("disabled={!checked && visibleSeries.length >= MAX_TREND_CATEGORY_LIMIT}");
    expect(source).toContain('id="si-inventory-trend-legend-list" hidden={!legendExpanded}');
    expect(source).not.toContain("<Legend");
  });
});

function datesAsLabels(dates: readonly string[]): string[] {
  return dates.map((date) => date.slice(5));
}
