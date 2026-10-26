import type { ListQuery, ProductFilters, ProductFull, ProductView, SiteIndexApi } from "@siteindex/shared";
import { FIXED_TODAY, fixtures, productRows, productsByProject, projectKey, recordsByProject, reply, seoPages, selectRows, tagNamesByProject, tagsByHandle } from "./context";

export function createProductsMock(): SiteIndexApi["products"] {
  return {
    list: (id, query: ListQuery<ProductFilters>) => reply(() => selectRows(
      productRows(id), query,
      (row) => [row.title, row.handle, row.category, ...row.tags].join(" "),
      (row, filters) => {
        const stock = filters.stock as ProductFilters["stock"];
        const tag = filters.tag as string | undefined;
        const category = filters.category as string | undefined;
        return (!stock || (stock === "in" ? row.stock_status === "in_stock" : stock === "out" ? row.stock_status === "out_of_stock" : row.stock_status === "preorder" || row.stock_status === "unknown")) && (!tag || row.tags.includes(tag)) && (!category || row.category === category);
      },
    )),
    get: (id, handle) => reply<ProductFull>(() => {
      const rows = productRows(id);
      const product = rows.find((row) => row.handle === handle) ?? rows[0] ?? (fixtures.products[0] as ProductView);
      const skus = recordsByProject[projectKey(id)].filter((row) => row.handle === product.handle);
      const seoPage = seoPages.find((page) => page.url === product.url) ?? seoPages.find((page) => page.page_type === "product");
      return {
        product, skus,
        details: {
          handle: product.handle, short_description: product.short_description ?? "为日常户外使用设计的耐用产品。",
          rating: product.rating ?? null, review_count: product.review_count ?? null,
          breadcrumbs: ["首页", product.category, product.title],
          gallery: product.image_url ? [product.image_url] : [],
          related_handles: rows.filter((row) => row.handle !== product.handle && row.category === product.category).slice(0, 3).map((row) => row.handle),
          badges: [product.is_new ? "新品" : "", product.on_sale ? "促销" : ""].filter(Boolean),
          shipping_note: "订单满 $50 免运费。", last_crawled: FIXED_TODAY,
        },
        seo: seoPage
          ? { url: seoPage.url, title: seoPage.title, robots_meta: seoPage.robots_meta, schema_types: seoPage.schema_types.length ? seoPage.schema_types : ["Product"], google_indexed: seoPage.google_indexed ?? null }
          : { url: product.url, title: product.title, robots_meta: null, schema_types: ["Product"], google_indexed: null },
      };
    }),
    setTags: (id, handle, tags) => reply(() => {
      tagsByHandle.set(id + ":" + handle, [...new Set(tags)]);
      tags.forEach((tag) => tagNamesByProject[projectKey(id)].add(tag));
      return tagsByHandle.get(id + ":" + handle) ?? [];
    }),
    listTags: (id) => reply(() => [...tagNamesByProject[projectKey(id)]].sort().map((tag) => ({ tag, products: productRows(id).filter((row) => row.tags.includes(tag)).length }))),
    createTag: (id, tag) => reply(() => { tagNamesByProject[projectKey(id)].add(tag); return [...tagNamesByProject[projectKey(id)]].sort().map((item) => ({ tag: item, products: productRows(id).filter((row) => row.tags.includes(item)).length })); }),
    deleteTag: (id, tag) => reply(() => {
      tagNamesByProject[projectKey(id)].delete(tag);
      for (const product of productsByProject[projectKey(id)]) {
        const current = tagsByHandle.get(id + ":" + product.handle) ?? product.tags;
        tagsByHandle.set(id + ":" + product.handle, current.filter((item) => item !== tag));
      }
      return [...tagNamesByProject[projectKey(id)]].sort().map((item) => ({ tag: item, products: productRows(id).filter((row) => row.tags.includes(item)).length }));
    }),
    exportCsv: (id) => reply("mock:/exports/" + id + "-products.csv"),
  };
}
