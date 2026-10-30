import type { InventorySummary } from "@siteindex/shared";

export const DEFAULT_TREND_CATEGORY_LIMIT = 3;
export const MAX_TREND_CATEGORY_LIMIT = 5;

export type TrendPoint = Record<string, string | number | null>;

export function defaultTrendCategories(summary: InventorySummary): string[] {
  const available = summary.trend.series.map((series) => series.category);
  const availableSet = new Set(available);
  const watched = summary.category_rates.filter((category) => category.watched).map((category) => category.category);
  const prioritized = [...watched.filter((category) => availableSet.has(category)), ...available];
  return [...new Set(prioritized)].slice(0, DEFAULT_TREND_CATEGORY_LIMIT);
}

export function trendPoints(summary: InventorySummary, selectedCategories: readonly string[]): TrendPoint[] {
  const selected = new Set(selectedCategories);
  return summary.trend.dates.map((date, index) => {
    const point: TrendPoint = { day: date.slice(5) };
    for (const series of summary.trend.series) {
      if (selected.has(series.category)) point[series.category] = series.rates[index] ?? null;
    }
    return point;
  });
}

export function toggleTrendCategory(selection: readonly string[], category: string): string[] {
  if (selection.includes(category)) return selection.filter((item) => item !== category);
  if (selection.length >= MAX_TREND_CATEGORY_LIMIT) return [...selection];
  return [...selection, category];
}
