import { describe, expect, it } from "vitest";
import type { HistoryRange } from "@siteindex/shared";
import { FIXED_TODAY, rowsByProject } from "../context";
import { createInventoryMock } from "../inventory";

describe("inventory range mock", () => {
  it("accepts legacy and expanded ranges without inventing dates", async () => {
    const api = createInventoryMock();
    const ranges: (14 | HistoryRange)[] = [14, 30, 60, 90, "all"];

    for (const range of ranges) {
      const summary = await api.summary("demo", range);
      expect(summary.trend.dates).toEqual([FIXED_TODAY]);
      expect(summary.trend.series.every((series) => series.rates.length === 1)).toBe(true);
      for (const series of summary.trend.series) {
        expect(series.rates[0]).toBe(summary.category_rates.find((item) => item.category === series.category)?.rate);
      }
    }
  });
});

describe("inventory watched categories mock", () => {
  it("returns watched/manual markers from the project configuration", async () => {
    const api = createInventoryMock();
    const summary = await api.summary("demo", 30);

    expect(summary.category_rates.find((item) => item.category === "demo-category-1")).toMatchObject({
      watched: true,
      manual: true,
      total: expect.any(Number),
    });
    expect(summary.category_rates.find((item) => item.category === "demo-category-5")).toMatchObject({
      watched: false,
      manual: true,
      total: 0,
    });
  });

  it("applies watched_only to rows returned by the inventory API", async () => {
    const api = createInventoryMock();
    const result = await api.listSkus("demo", { page: 1, pageSize: 0, filters: { watched_only: true } });

    expect(result.total).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.category === "demo-category-1")).toBe(true);
  });
});

describe("inventory parent view mock", () => {
  it("keeps independent SKUs and resolves child SKU searches to the parent", async () => {
    const api = createInventoryMock();
    const original = rowsByProject.demo;
    const sample = original[0]!;
    rowsByProject.demo = [
      { ...sample, sku: "DEMO001A01", parent_sku: "DEMO001A", stock_status: "in_stock", history_30d: "i".repeat(30), price: 30 },
      { ...sample, sku: "DEMO001A02", parent_sku: "DEMO001A", stock_status: "out_of_stock", history_30d: "o".repeat(30), price: 20 },
      { ...sample, sku: "INDEPENDENT", parent_sku: null, stock_status: "unknown" },
    ];
    try {
      const result = await api.listSkus("demo", { page: 1, pageSize: 0, filters: { parent_only: true } });
      expect(result.rows.map((row) => row.sku)).toEqual(["DEMO001A", "INDEPENDENT"]);
      expect(result.rows[0]).toMatchObject({
        price: 20,
        stock_status: "in_stock",
        online_rate_7d: 1,
        online_rate_30d: 1,
        history_30d: "i".repeat(30),
        children_count: 2,
        in_stock_children_count: 1,
      });
      const found = await api.listSkus("demo", { page: 1, pageSize: 0, search: "DEMO001A02", filters: { parent_only: true } });
      expect(found.rows.map((row) => row.sku)).toEqual(["DEMO001A"]);

      rowsByProject.demo = rowsByProject.demo.map((row) => ({ ...row, history_30d: "-".repeat(30) }));
      const unavailable = await api.listSkus("demo", { page: 1, pageSize: 0, filters: { parent_only: true } });
      expect(unavailable.rows[0]).toMatchObject({
        online_rate_7d: null,
        online_rate_30d: null,
        history_30d: "-".repeat(30),
      });
    } finally {
      rowsByProject.demo = original;
    }
  });

  it("matches Core stock-change dates and treats short histories as unknown", async () => {
    const api = createInventoryMock();
    const original = rowsByProject.demo;
    const sample = original[0]!;
    rowsByProject.demo = [
      { ...sample, sku: "DEMO001A01", parent_sku: "DEMO001A", stock_status: "in_stock", history_30d: "-".repeat(20) + "ooiiooouoi" },
      { ...sample, sku: "DEMO001A02", parent_sku: "DEMO001A", stock_status: "out_of_stock", history_30d: "-".repeat(20) + "oooopppuoo" },
      { ...sample, sku: "DEMO002B01", parent_sku: "DEMO002B", stock_status: "out_of_stock", history_30d: "-".repeat(30) },
      { ...sample, sku: "DEMO002B02", parent_sku: "DEMO002B", stock_status: "out_of_stock", history_30d: "-".repeat(30) },
      // 模拟 Core 尚未补齐 30 天历史的行；越界日期与 Core 一样按未知状态处理。
      { ...sample, sku: "DEMO003C01", parent_sku: "DEMO003C", stock_status: "in_stock", history_30d: "i" },
    ];

    try {
      const result = await api.listSkus("demo", { page: 1, pageSize: 0, filters: { parent_only: true } });
      expect(result.rows.find((row) => row.sku === "DEMO001A")).toMatchObject({
        history_30d: "-".repeat(20) + "ooiipppuoi",
        online_rate_7d: 2 / 7,
        online_rate_30d: 0.3,
        changes_30d: 5,
        last_change: "stock_change",
        last_change_at: FIXED_TODAY,
      });
      expect(result.rows.find((row) => row.sku === "DEMO002B")).toMatchObject({
        history_30d: "-".repeat(30),
        online_rate_7d: null,
        online_rate_30d: null,
        changes_30d: 0,
        last_change: null,
        last_change_at: null,
      });
      expect(result.rows.find((row) => row.sku === "DEMO003C")).toMatchObject({
        history_30d: "i" + "u".repeat(29),
        online_rate_7d: 0,
        online_rate_30d: 1 / 30,
        changes_30d: 1,
        last_change: "stock_change",
        last_change_at: "2026-09-24",
      });
    } finally {
      rowsByProject.demo = original;
    }
  });
});
