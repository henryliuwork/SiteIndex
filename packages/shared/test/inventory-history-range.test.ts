import { describe, expect, it } from "vitest";
import type { HistoryRange, SiteIndexApi } from "../src";

function callEverySupportedRange(summary: SiteIndexApi["inventory"]["summary"]) {
  const ranges: (14 | HistoryRange)[] = [14, 30, 60, 90, "all"];
  return [summary("contract-fixture"), ...ranges.map((range) => summary("contract-fixture", range))];
}

describe("inventory summary history range contract", () => {
  it("keeps legacy ranges and accepts the expanded history ranges", async () => {
    const supportedRanges: (14 | HistoryRange)[] = [14, 30, 60, 90, "all"];
    const calls: (14 | HistoryRange | undefined)[] = [];
    const summary: SiteIndexApi["inventory"]["summary"] = async (_id, days) => {
      calls.push(days);
      return {
        as_of: "2026-10-30",
        kpis: [],
        trend: { dates: [], series: [] },
        category_rates: [],
        category_source: "feed",
        uncategorized: 0,
        today: [],
      };
    };

    expect(supportedRanges).toEqual([14, 30, 60, 90, "all"]);
    await Promise.all(callEverySupportedRange(summary));
    expect(calls).toEqual([undefined, ...supportedRanges]);
  });
});
