import { describe, expect, it } from "vitest";
import { selectInventoryDates, type InventorySummaryRange } from "../src/inventory/history-range";

function dateAtOffset(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
}

describe("inventory history range", () => {
  it("selects the latest distinct business dates in stable ascending order", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ date: dateAtOffset(99 - index) }));
    rows.push({ date: dateAtOffset(99) });

    const expectedRanges: readonly [InventorySummaryRange, number][] = [
      [14, 14],
      [30, 30],
      [60, 60],
      [90, 90],
      ["all", 100],
    ];

    for (const [range, count] of expectedRanges) {
      const dates = selectInventoryDates(rows, range);
      expect(dates).toHaveLength(count);
      expect(dates).toEqual([...dates].sort());
      expect(dates).toEqual(Array.from({ length: count }, (_, index) => dateAtOffset(100 - count + index)));
    }
  });

  it("returns only recorded dates when the requested range exceeds history", () => {
    const rows = [
      { date: "2026-10-20" },
      { date: "2026-10-18" },
      { date: "2026-10-20" },
      { date: "2026-10-19" },
    ];
    const expected = ["2026-10-18", "2026-10-19", "2026-10-20"];

    expect(selectInventoryDates(rows, 14)).toEqual(expected);
    expect(selectInventoryDates(rows, 30)).toEqual(expected);
    expect(selectInventoryDates(rows, 60)).toEqual(expected);
    expect(selectInventoryDates(rows, 90)).toEqual(expected);
    expect(selectInventoryDates(rows, "all")).toEqual(expected);
  });

  it("preserves the empty-history result", () => {
    expect(selectInventoryDates([], "all")).toEqual([]);
    expect(selectInventoryDates([], 90)).toEqual([]);
  });
});
