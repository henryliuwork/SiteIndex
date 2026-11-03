import type { CategoryPreview, SiteIndexApi } from "@siteindex/shared";
import { categoryConfigs, categorySeeds, clone, projectKey, reply } from "./context";

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
  return {
    get: (id) => reply(categoryConfigs[projectKey(id)]),
    preview: (_id, config) => reply<CategoryPreview>(() => ({
      categories: categoriesWithUniqueSlugs(config.manual ?? categorySeeds.slice(0, 5)).map((category, index) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: [11, 4, 4, 0][index] ?? 0 })),
      uncategorized: 0, multi_matched: 0,
      candidates: [
        { url: "/collections/demo-category-4", product_links: 6 },
        { url: "/collections/demo-category-2", product_links: 9 },
        { url: "/collections/demo-category-1", product_links: 11 },
      ].map((candidate) => ({ ...candidate, configured: (config.manual ?? []).some((item) => item.url === candidate.url || item.url.endsWith(candidate.url)) })),
    })),
    save: (id, config) => reply(() => {
      categoryConfigs[projectKey(id)] = clone(config);
      return { categories: categoriesWithUniqueSlugs(config.manual ?? categorySeeds).map((category, index) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: [11, 4, 4, 0][index] ?? 0 })), uncategorized: 0, multi_matched: 0, candidates: [] };
    }),
  };
}
