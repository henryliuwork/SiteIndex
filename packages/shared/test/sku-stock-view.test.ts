import { describe, expect, it } from "vitest";
import type { SkuStockView } from "../src/models";

describe("SKU stock view parent row contract", () => {
  it("keeps the new parent fields optional for existing stock rows", () => {
    const child: SkuStockView = {
      sku: "DEMO001A01",
      title: "Synthetic child",
      variant_title: null,
      category: "demo-category",
      price: 20,
      stock_status: "in_stock",
      since: "2026-11-03",
      days_in_status: 1,
      online_rate_7d: null,
      online_rate_30d: null,
      history_30d: "i".repeat(30),
      changes_30d: 0,
      last_change: null,
      last_change_at: null,
      parent_sku: "DEMO001A",
    };
    const parent: SkuStockView = {
      ...child,
      sku: "DEMO001A",
      variant_title: null,
      parent_sku: null,
      is_parent: true,
      children_count: 2,
      in_stock_children_count: 1,
    };

    expect(child).not.toHaveProperty("is_parent");
    expect(parent).toMatchObject({ is_parent: true, children_count: 2, in_stock_children_count: 1 });
  });
});
