import type { ListQuery, ProductFilters, ProductFull, SiteIndexApi } from "@siteindex/shared";
import { productRows, productsByProject, projectKey, recordsByProject, reply, seoPages, selectRows, tagNamesByProject, tagsByHandle } from "./context";

export function createProductsMock(): SiteIndexApi["products"] {
  return {
    list: (id, query: ListQuery<ProductFilters>) => reply(() => selectRows(
      productRows(id), query,
      (row) => [row.handle, row.title, row.product_id, row.skus, row.category, row.categories, row.tags].join(" "),
      (row, filters) => {
        const stock = filters.stock as ProductFilters["stock"];
        const tag = filters.tag?.trim().toLowerCase();
        const category = filters.category as string | undefined;
        return (!stock || (stock === "in" ? row.stock_status === "in_stock" : stock === "out" ? row.stock_status === "out_of_stock" : row.stock_status === "preorder" || row.stock_status === "unknown"))
          && (!tag || row.tags.some((value) => value.trim().toLowerCase() === tag))
          && (!category || row.category === category || row.categories.includes(category));
      },
      "handle", (row) => row.handle,
    )),
    get: (id, handle) => reply<ProductFull>(() => {
      const rows = productRows(id);
      const product = rows.find((row) => row.handle === handle);
      if (!product) throw { code: "UNKNOWN", message: "找不到指定产品", detail: handle };
      const skus = recordsByProject[projectKey(id)].filter((row) => row.handle === product.handle);
      const seoPage = seoPages.find((page) => page.url === product.url);
      return {
        product, skus, details: null,
        seo: seoPage
          ? { url: seoPage.url, title: seoPage.title, robots_meta: seoPage.robots_meta, schema_types: seoPage.schema_types, google_indexed: seoPage.google_indexed ?? null }
          : null,
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
