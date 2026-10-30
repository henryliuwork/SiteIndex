import type { HistoryRange, ISODate } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

export type InventorySummaryRange = 14 | HistoryRange;

/** Select distinct business dates without inventing days that have no records. */
export function selectInventoryDates(
  rows: readonly { date: ISODate }[],
  range: InventorySummaryRange,
): ISODate[] {
  const dates = [...new Set(rows.map((row) => row.date))].sort(compareKeys);
  return range === "all" ? dates : dates.slice(-range);
}
