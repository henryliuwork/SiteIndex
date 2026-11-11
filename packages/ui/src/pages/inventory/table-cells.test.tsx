// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SkuStockView } from "@siteindex/shared";
import { formatInventoryDetailDuration, formatInventoryTableDuration, InventoryHistoryCell, InventoryRateCell } from "./table-cells";

const baseRow: SkuStockView = {
  sku: "DEMO-PARENT", title: "虚构演示商品", variant_title: null,
  category: "demo-category", price: 10, stock_status: "in_stock", since: "2026-11-01", days_in_status: 1,
  online_rate_7d: null, online_rate_30d: null, history_30d: "-".repeat(30), changes_30d: 0,
  last_change: null, last_change_at: null, parent_sku: null, price_history: [], is_parent: true,
  children_count: 2, in_stock_children_count: 1,
};

describe("Inventory table aggregate cells", () => {
  it("uses table duration labels for child SKUs, but never shows a parent placeholder", () => {
    expect(formatInventoryTableDuration(baseRow)).toBe("—");
    expect(formatInventoryTableDuration({ is_parent: false, days_in_status: 1 })).toBe("今天");
    expect(formatInventoryTableDuration({ is_parent: false, days_in_status: 90 })).toBe("60 天+");
  });

  it("keeps exact child duration in the detail drawer while suppressing parent placeholders", () => {
    expect(formatInventoryDetailDuration(baseRow)).toBe("—");
    expect(formatInventoryDetailDuration({ is_parent: false, days_in_status: 1 })).toBe("1 天");
    expect(formatInventoryDetailDuration({ is_parent: false, days_in_status: 90 })).toBe("90 天");
  });

  it("shows a dash without a rate track for missing aggregate rates", () => {
    const { container } = render(<InventoryRateCell value={null} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(container.querySelector(".si-rate-track")).toBeNull();
  });

  it("shows an actual aggregate rate when Core provides it", () => {
    const { container } = render(<InventoryRateCell value={0.75} />);
    expect(screen.getByText("75%")).toBeTruthy();
    expect(container.querySelector(".si-rate-track")).toBeTruthy();
  });

  it("shows a dash instead of placeholder bars when parent history is missing", () => {
    const { container } = render(<InventoryHistoryCell row={baseRow} />);
    expect(container.textContent).toBe("—");
    expect(container.querySelector(".si-status-cells")).toBeNull();
  });

  it("renders the stock trend cells when aggregate history is present", () => {
    const row = { ...baseRow, history_30d: "i".repeat(30), online_rate_30d: 1 };
    const { container } = render(<InventoryHistoryCell row={row} />);
    expect(container.querySelector(".si-status-cells")).toBeTruthy();
  });
});
