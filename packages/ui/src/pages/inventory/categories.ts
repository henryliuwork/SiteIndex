import type { InventorySummary, WatchedCategory } from "@siteindex/shared";

export type InventoryCategoryRate = InventorySummary["category_rates"][number] & {
  watched: boolean;
  manual: boolean;
  label: string;
};

export function selectInventoryCategoryRates(
  summary: InventorySummary,
  watchedCategories: readonly WatchedCategory[],
  showDefaultCategories: boolean,
): InventoryCategoryRate[] {
  const labels = new Map<string, string>();
  for (const category of watchedCategories) {
    if (category.slug?.trim()) labels.set(category.slug.trim(), category.name);
    labels.set(category.name.trim(), category.name);
  }

  const rates = summary.category_rates.map((item) => ({
    ...item,
    watched: item.watched === true,
    manual: item.manual === true,
    label: labels.get(item.category) ?? item.category,
  }));

  return watchedCategories.length > 0 && !showDefaultCategories
    ? rates.filter((item) => item.watched)
    : rates;
}
