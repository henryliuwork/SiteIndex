import type { CategoryPreview, SiteIndexApi } from "@siteindex/shared";
import { categoryConfigs, categorySeeds, clone, projectKey, reply } from "./context";

const urlRuleCandidates = [
  { slug: "demo-category-1", name: "演示分类 1", url: "/shop/demo-category-1", sku_count: 11 },
  { slug: "demo-category-2", name: "演示分类 2", url: "/product-category/demo-category-2", sku_count: 4 },
  { slug: "demo-category-3", name: "演示分类 3", url: "/collections/demo-category-3", sku_count: 4 },
];

function matchesUrlRule(url: string, value: string): boolean {
  return value.split(",").map((pattern) => pattern.trim()).filter(Boolean).some((pattern) => {
    const escaped = pattern.split("{slug}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
    return new RegExp(`^${escaped}(?:/|$)`, "i").test(url);
  });
}

function categoriesWithUniqueSlugs(categories: readonly { slug: string; name: string; url: string }[]): { slug: string; name: string; url: string }[] {
  const reservedSlugs = new Set(categories.map((category) => category.slug));
  const assignedSlugs = new Set<string>();
  let nextNumber = 1;

  return categories.map((category) => {
    let slug = category.slug;
    if (assignedSlugs.has(slug)) {
      do {
        slug = `demo-category-${nextNumber++}`;
      } while (reservedSlugs.has(slug) || assignedSlugs.has(slug));
    }
    assignedSlugs.add(slug);

    const urlIndex = category.url.lastIndexOf(category.slug);
    const url = slug === category.slug || urlIndex < 0
      ? category.url
      : category.url.slice(0, urlIndex) + slug + category.url.slice(urlIndex + category.slug.length);
    const name = slug === category.slug ? category.name : `示例分类 ${slug.replace(/^demo-category-/, "")}`;
    return { ...category, slug, url, name };
  });
}

export function createCategoriesMock(): SiteIndexApi["categories"] {
  const previewFor = (config: Parameters<SiteIndexApi["categories"]["preview"]>[1]): CategoryPreview => {
    const urlCategories = urlRuleCandidates.filter((candidate) => matchesUrlRule(candidate.url, config.url_pattern ?? ""));
    return {
      categories: config.mode === "url_rule" ? urlCategories : categoriesWithUniqueSlugs(config.manual ?? categorySeeds.slice(0, 5)).map((category, index) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: [11, 4, 4, 0][index] ?? 0 })),
      uncategorized: config.mode === "url_rule" ? 19 - urlCategories.reduce((sum, category) => sum + category.sku_count, 0) : 0,
      multi_matched: 0,
      candidates: [...urlRuleCandidates.map(({ url, sku_count }) => ({ url, product_links: sku_count })),
        { url: "/collections/demo-category-4", product_links: 6 }].map((candidate) => ({
          ...candidate,
          configured: config.mode === "url_rule" ? matchesUrlRule(candidate.url, config.url_pattern ?? "") : (config.manual ?? []).some((item) => item.url === candidate.url || item.url.endsWith(candidate.url)),
        })),
    };
  };
  return {
    get: (id) => reply(categoryConfigs[projectKey(id)]),
    preview: (_id, config) => reply<CategoryPreview>(() => previewFor(config)),
    save: (id, config) => reply(() => {
      categoryConfigs[projectKey(id)] = clone(config);
      return previewFor(config);
    }),
  };
}
