import type { HistoryRange, InventoryEvent, ISODate } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

export interface PriceHistoryPoint {
  date: ISODate;
  price: number;
}

/** Build price points only from recorded price_change events; current SKU prices are not backfilled. */
export function buildPriceHistory(
  events: readonly InventoryEvent[],
  asOf: ISODate,
): Map<string, PriceHistoryPoint[]> {
  const histories = new Map<string, PriceHistoryPoint[]>();
  for (const event of events) {
    if (event.type !== "price_change" || event.date > asOf
      || typeof event.to !== "number" || !Number.isFinite(event.to) || event.to < 0) continue;
    const points = histories.get(event.sku) ?? [];
    points.push({ date: event.date, price: event.to });
    histories.set(event.sku, points);
  }
  for (const points of histories.values()) points.sort((left, right) => compareKeys(left.date, right.date));
  return histories;
}

/** Match a real recorded price change within a calendar-day range ending on the site's business date. */
export function hasPriceChangeWithin(
  history: readonly PriceHistoryPoint[] | undefined,
  range: HistoryRange,
  asOf: ISODate,
): boolean {
  if (!history?.length) return false;
  if (range === "all") return history.some((point) => point.date <= asOf);
  const asOfTimestamp = Date.parse(`${asOf}T00:00:00.000Z`);
  if (!Number.isFinite(asOfTimestamp)) return false;
  const cutoff = new Date(asOfTimestamp - range * 86_400_000).toISOString().slice(0, 10);
  return history.some((point) => point.date >= cutoff && point.date <= asOf);
}
