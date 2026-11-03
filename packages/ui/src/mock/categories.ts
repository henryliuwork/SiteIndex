import type { CategoryPreview, SiteIndexApi } from "@siteindex/shared";
import { categoryConfigs, categorySeeds, clone, projectKey, reply } from "./context";

export function createCategoriesMock(): SiteIndexApi["categories"] {
  return {
    get: (id) => reply(categoryConfigs[projectKey(id)]),
    preview: (_id, config) => reply<CategoryPreview>(() => ({
      categories: (config.manual ?? categorySeeds.slice(0, 5)).map((category, index) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: [11, 4, 4, 0][index] ?? 0 })),
      uncategorized: 0, multi_matched: 0,
      candidates: [
        { url: "/collections/demo-category-4", product_links: 6 },
        { url: "/collections/demo-category-2", product_links: 9 },
        { url: "/collections/demo-category-1", product_links: 11 },
      ].map((candidate) => ({ ...candidate, configured: (config.manual ?? []).some((item) => item.url === candidate.url || item.url.endsWith(candidate.url)) })),
    })),
    save: (id, config) => reply(() => {
      categoryConfigs[projectKey(id)] = clone(config);
      return { categories: (config.manual ?? categorySeeds).map((category, index) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: [11, 4, 4, 0][index] ?? 0 })), uncategorized: 0, multi_matched: 0, candidates: [] };
    }),
  };
}
