import type { SkuStockView } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { parentStockRows } from "../src/inventory/parent-stock-view";

function childRow(
  sku: string,
  parentSku: string,
  stockStatus: SkuStockView["stock_status"],
  history: string,
): SkuStockView {
  return {
    sku,
    title: "Fictional demo item",
    variant_title: null,
    category: "demo-category",
    price: 10,
    stock_status: stockStatus,
    since: "2026-11-01",
    days_in_status: 9,
    online_rate_7d: null,
    online_rate_30d: null,
    history_30d: history,
    changes_30d: 0,
    last_change: null,
    last_change_at: null,
    parent_sku: parentSku,
  };
}

describe("parent SKU stock history", () => {
  it("aggregates daily child states, online rates and the latest aggregate stock change", () => {
    const demoHistoryFixture = [
      childRow("DEMO010A01", "DEMO010A", "in_stock", "-".repeat(20) + "ooiiooouoi"),
      childRow("DEMO010A02", "DEMO010A", "out_of_stock", "-".repeat(20) + "oooopppuoo"),
      childRow("DEMO020B01", "DEMO020B", "out_of_stock", "o".repeat(30)),
      childRow("DEMO020B02", "DEMO020B", "out_of_stock", "o".repeat(30)),
    ];

    const result = parentStockRows(demoHistoryFixture, "2026-11-09");
    const parentWithTransitions = result.rows.find((row) => row.sku === "DEMO010A");
    const allOutParent = result.rows.find((row) => row.sku === "DEMO020B");

    expect(parentWithTransitions).toMatchObject({
      stock_status: "in_stock",
      history_30d: "-".repeat(20) + "ooiipppuoi",
      online_rate_7d: 2 / 7,
      online_rate_30d: 0.3,
      changes_30d: 5,
      last_change: "stock_change",
      last_change_at: "2026-11-09",
    });
    expect(allOutParent).toMatchObject({
      stock_status: "out_of_stock",
      history_30d: "o".repeat(30),
      online_rate_7d: 0,
      online_rate_30d: 0,
      changes_30d: 0,
      last_change: null,
      last_change_at: null,
    });
  });
});
