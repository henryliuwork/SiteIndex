import type { EdmCommandInput, ListQuery, SkuImageFilters, SiteIndexApi } from "@siteindex/shared";
import { edmImageRows, fixtures, manualImages, mockFeedImageUrl, projectKey, recordsByProject, reply, rowsByProject, selectRows } from "./context";

export function createEdmMock(): SiteIndexApi["edm"] {
  return {
    summary: (id) => reply(() => {
      const rows = edmImageRows(id);
      return { total: rows.length, feed: rows.filter((row) => row.feed_image_url).length, manual: rows.filter((row) => row.manual_image_url).length, none: rows.filter((row) => row.used === "none").length };
    }),
    listImages: (id, query: ListQuery<SkuImageFilters>) => reply(() => {
      return selectRows(edmImageRows(id), query, (row) => [row.sku, row.title].join(" "), (row, filters) => !filters.view || (filters.view === "in_stock" ? row.stock_status === "in_stock" : filters.view === "no_feed" ? row.feed_image_url == null : filters.view === "has_manual" ? row.manual_image_url != null : row.used === "none"));
    }),
    setManualImage: (id, sku, url) => reply(() => {
      if (url) manualImages.set(id + ":" + sku, url);
      else manualImages.delete(id + ":" + sku);
      const key = projectKey(id);
      const index = recordsByProject[key].slice(0, fixtures.skus.length).findIndex((row) => row.sku === sku);
      const record = recordsByProject[key][index];
      const stock = rowsByProject[key].find((row) => row.sku === sku);
      const feed = index === 4 || index === 18 ? null : record ? mockFeedImageUrl(record) : null;
      return {
        sku, title: record?.title ?? sku, variant_title: record?.variant_title ?? null,
        stock_status: stock?.stock_status ?? "unknown", feed_image_url: feed,
        manual_image_url: url, used: url ? "manual" : feed ? "feed" : "none",
      };
    }),
    buildCommand: (_id, input: EdmCommandInput) => reply("edm-builder --theme \"" + input.theme + "\" --count " + input.count + (input.promo_code ? " --promo-code \"" + input.promo_code + "\"" : "")),
  };
}
