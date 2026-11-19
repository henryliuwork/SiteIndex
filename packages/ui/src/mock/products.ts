import type { InventoryEvent, ListQuery, ProductFilters, ProductFull, ProductView, SiteIndexApi } from "@siteindex/shared";
import { fixtures, productRows, productsByProject, projectKey, recordsByProject, reply, rowsByProject, seoPages, selectRows, tagNamesByProject, tagsByHandle } from "./context";

const scenarioMetadata = (missing_fields: string[] = []) => ({
  sources: [{ kind: "mock-index" }], collected_at: null, missing_fields,
  quality: missing_fields.length ? "partial" as const : "complete" as const, anomalies: [],
});

function mockProductRows(id: string): ProductView[] {
  const base = productRows(id);
  const template = base[0];
  if (!template) return base;
  const key = projectKey(id);
  const covered = new Set(base.flatMap((product) => product.skus));
  const records = new Map(recordsByProject[key].map((record) => [record.sku, record]));
  const generated = rowsByProject[key].filter((stock) => !covered.has(stock.sku)).map((stock): ProductView => {
    const record = records.get(stock.sku);
    const handle = record?.handle ?? stock.sku.toLowerCase();
    return {
      ...template, handle, product_id: record?.product_id ?? stock.sku,
      title: stock.title, url: record?.url ?? `https://demo-store.example.test/products/${handle}`,
      category: stock.category, categories: [stock.category], skus: [stock.sku],
      price_min: stock.price, price_max: stock.price, compare_at_max: null,
      variant_count: 1, in_stock_variants: stock.stock_status === "in_stock" ? 1 : 0,
      row_kind: "single", parent_sku: null, stock_status: stock.stock_status, stock_since: stock.since,
      tags: tagsByHandle.get(id + ":" + handle) ?? [], rating: null, review_count: null,
      on_sale: false, is_new: false,
      restocked_at: null, price_dropped_at: null, first_seen: record?.first_seen ?? template.first_seen,
    };
  });
  return [...base, ...generated];
}

export function createProductsMock(): SiteIndexApi["products"] {
  return {
    list: (id, query: ListQuery<ProductFilters>) => reply(() => selectRows(
      mockProductRows(id), query,
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
      const rows = mockProductRows(id);
      const product = rows.find((row) => row.handle === handle);
      if (!product) throw { code: "UNKNOWN", message: "找不到指定产品", detail: handle };
      const key = projectKey(id);
      const skus = recordsByProject[key].filter((row) => row.handle === product.handle);
      const skuIds = new Set(product.skus);
      const variants = rowsByProject[key].filter((row) => skuIds.has(row.sku)).sort((left, right) => left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0).map((row) => ({
        sku: row.sku,
        title: row.title,
        stock_status: row.stock_status,
        since: row.since,
        days_in_status: row.days_in_status,
        price: row.price,
        history_30d: row.history_30d,
        online_rate_30d: row.online_rate_30d,
      }));
      const seoPage = seoPages.find((page) => page.url === product.url);
      return {
        product, skus, variants, details: null,
        seo: seoPage
          ? { url: seoPage.url, title: seoPage.title, robots_meta: seoPage.robots_meta, schema_types: seoPage.schema_types, google_indexed: seoPage.google_indexed ?? null }
          : null,
      };
    }),
    skuBrief: (id, sku) => reply(() => {
      const record = recordsByProject[projectKey(id)].find((item) => item.sku === sku);
      const stock = rowsByProject[projectKey(id)].find((item) => item.sku === sku) ?? null;
      return { data: record ? { sku: record, stock } : null, metadata: scenarioMetadata(record ? stock ? [] : ["stock"] : ["sku"]) };
    }),
    changes: (_id, sku) => reply(() => ({
      data: fixtures.events.filter((event) => !sku || event.sku === sku).map((event): InventoryEvent => ({ ...event, type: event.type as InventoryEvent["type"] })),
      metadata: scenarioMetadata(),
    })),
    groupFamily: (id, sku) => reply(() => {
      const records = recordsByProject[projectKey(id)];
      const record = records.find((item) => item.sku === sku);
      const rows = rowsByProject[projectKey(id)];
      const stock = rows.find((item) => item.sku === sku);
      const child_skus = rows.filter((item) => item.parent_sku === sku).map((item) => item.sku).sort();
      return { data: record ? {
        sku, role: stock?.parent_sku ? "child" as const : child_skus.length ? "parent" as const : "single" as const,
        parent_sku: stock?.parent_sku ?? null, child_skus, collision: null,
      } : null, metadata: scenarioMetadata(record ? [] : ["sku"]) };
    }),
    setTags: (id, handle, tags) => reply(() => {
      tagsByHandle.set(id + ":" + handle, [...new Set(tags)]);
      tags.forEach((tag) => tagNamesByProject[projectKey(id)].add(tag));
      return tagsByHandle.get(id + ":" + handle) ?? [];
    }),
    listTags: (id) => reply(() => [...tagNamesByProject[projectKey(id)]].sort().map((tag) => ({ tag, products: mockProductRows(id).filter((row) => row.tags.includes(tag)).length }))),
    createTag: (id, tag) => reply(() => { tagNamesByProject[projectKey(id)].add(tag); return [...tagNamesByProject[projectKey(id)]].sort().map((item) => ({ tag: item, products: mockProductRows(id).filter((row) => row.tags.includes(item)).length })); }),
    deleteTag: (id, tag) => reply(() => {
      tagNamesByProject[projectKey(id)].delete(tag);
      for (const product of mockProductRows(id)) {
        const current = tagsByHandle.get(id + ":" + product.handle) ?? product.tags;
        tagsByHandle.set(id + ":" + product.handle, current.filter((item) => item !== tag));
      }
      return [...tagNamesByProject[projectKey(id)]].sort().map((item) => ({ tag: item, products: mockProductRows(id).filter((row) => row.tags.includes(item)).length }));
    }),
    exportCsv: (id) => reply("mock:/exports/" + id + "-products.csv"),
  };
}
