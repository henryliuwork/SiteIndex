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
