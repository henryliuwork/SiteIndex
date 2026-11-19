import { describe, expect, it } from "vitest";
import type { InventorySummary, SkuStockFilters } from "../src";

describe("product management summary additive contract", () => {
  const oldSummary = {
    as_of: "2026-11-18",
    kpis: [],
    trend: { dates: [], series: [] },
    category_rates: [],
    category_source: "feed",
    uncategorized: 0,
    today: [],
  } satisfies InventorySummary;

  it("accepts an older inventory summary and filter without the new fields", () => {
    const oldFilters = { status: "out_of_stock", parent_only: true } satisfies SkuStockFilters;

    expect(oldSummary).not.toHaveProperty("product_management");
    expect(oldFilters).not.toHaveProperty("summary_metric");
  });

  it("types the four default-row summary values and their matching filters", () => {
    const summary: InventorySummary = {
      ...oldSummary,
      product_management: {
        as_of: "2026-11-18",
        total_rows: 4,
        in_stock_rows: 1,
        online_rate: 0.25,
        changed_rows: 2,
        out_of_stock_7d_rows: 1,
        fluctuating_30d_rows: 1,
      },
    };
    const filters: SkuStockFilters[] = [
      { summary_metric: "in_stock" },
      { summary_metric: "changed" },
      { summary_metric: "out_of_stock_7d" },
      { summary_metric: "fluctuating_30d" },
    ];

    expect(summary.product_management?.online_rate).toBe(0.25);
    expect(filters.map((filter) => filter.summary_metric)).toEqual([
      "in_stock", "changed", "out_of_stock_7d", "fluctuating_30d",
    ]);
  });

  it("keeps missing business-date and history values distinct from zero", () => {
    const summary: InventorySummary = {
      ...oldSummary,
      product_management: {
        as_of: null,
        total_rows: 0,
        in_stock_rows: 0,
        online_rate: null,
        changed_rows: null,
        out_of_stock_7d_rows: null,
        fluctuating_30d_rows: null,
      },
    };

    expect(summary.product_management?.changed_rows).toBeNull();
  });
});
