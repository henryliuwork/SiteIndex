import { describe, expect, it } from "vitest";
import type { HistoryRange } from "@siteindex/shared";
import { FIXED_TODAY } from "../context";
import { createInventoryMock } from "../inventory";

describe("inventory range mock", () => {
  it("accepts legacy and expanded ranges without inventing dates", async () => {
    const api = createInventoryMock();
    const ranges: (14 | HistoryRange)[] = [14, 30, 60, 90, "all"];

    for (const range of ranges) {
      const summary = await api.summary("kingsyard", range);
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
    const summary = await api.summary("kingsyard", 30);

    expect(summary.category_rates.find((item) => item.category === "bird-feeders")).toMatchObject({
      watched: true,
      manual: true,
      total: expect.any(Number),
    });
    expect(summary.category_rates.find((item) => item.category === "hummingbird-feeders")).toMatchObject({
      watched: false,
      manual: true,
      total: 0,
    });
  });

  it("applies watched_only to rows returned by the inventory API", async () => {
    const api = createInventoryMock();
    const result = await api.listSkus("kingsyard", { page: 1, pageSize: 0, filters: { watched_only: true } });

    expect(result.total).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.category === "bird-feeders")).toBe(true);
  });
});
