import type { EdmCommandInput, ListQuery, SkuImageFilters, SiteIndexApi } from "@siteindex/shared";
import { edmImageRows, fixtures, manualImages, mockFeedImageUrl, projectConfigs, projectKey, recordsByProject, reply, rowsByProject, selectRows } from "./context";

function imageRowsForQuery(id: Parameters<SiteIndexApi["edm"]["listImages"]>[0], parentOnly: boolean) {
  const rows = edmImageRows(id);
  const childrenByParent = new Map<string, string[]>();
  const key = projectKey(id);
  if (!parentOnly || !projectConfigs[key].sku_grouping?.enabled) return { rows, childrenByParent };

  const existingSkus = new Set(rows.map((row) => row.sku));
  const stockBySku = new Map(rowsByProject[key].map((row) => [row.sku, row]));
  const grouped = new Map<string, typeof rows>();
  for (const image of rows) {
    const parent = stockBySku.get(image.sku)?.parent_sku;
    if (!parent || existingSkus.has(parent)) continue;
    const children = grouped.get(parent) ?? [];
    children.push(image);
    grouped.set(parent, children);
  }

  const groupedChildren = new Set<string>();
  const parents = [...grouped].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([parent, unsortedChildren]) => {
    const children = [...unsortedChildren].sort((left, right) => left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0);
    const skus = children.map((child) => child.sku);
    childrenByParent.set(parent, skus);
    skus.forEach((sku) => groupedChildren.add(sku));
    const statuses = children.map((child) => child.stock_status);
    const feedImage = children.find((child) => child.feed_image_url !== null)?.feed_image_url ?? null;
    const manualImage = children.find((child) => child.manual_image_url !== null)?.manual_image_url ?? null;
    return {
      ...children[0]!,
      sku: parent,
      variant_title: null,
      stock_status: statuses.includes("in_stock") ? "in_stock" as const
        : statuses.length > 0 && statuses.every((status) => status === "out_of_stock") ? "out_of_stock" as const
          : statuses.includes("preorder") ? "preorder" as const : "unknown" as const,
      feed_image_url: feedImage,
      manual_image_url: manualImage,
      used: feedImage ? "feed" as const : manualImage ? "manual" as const : "none" as const,
    };
  });
  return {
    rows: [...parents, ...rows.filter((row) => !groupedChildren.has(row.sku))].sort((left, right) => left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0),
    childrenByParent,
  };
}

export function createEdmMock(): SiteIndexApi["edm"] {
  return {
    summary: (id) => reply(() => {
      const rows = edmImageRows(id);
      return { total: rows.length, feed: rows.filter((row) => row.feed_image_url).length, manual: rows.filter((row) => row.manual_image_url).length, none: rows.filter((row) => row.used === "none").length };
    }),
    listImages: (id, query: ListQuery<SkuImageFilters>) => reply(() => {
      const { rows, childrenByParent } = imageRowsForQuery(id, Boolean(query.filters?.parent_only));
      return selectRows(rows, query, (row) => [row.sku, row.title, row.variant_title, ...(childrenByParent.get(row.sku) ?? [])].join(" "), (row, filters) => !filters.view || (filters.view === "in_stock" ? row.stock_status === "in_stock" : filters.view === "no_feed" ? row.feed_image_url === null : filters.view === "has_manual" ? row.manual_image_url !== null : row.feed_image_url === null && row.manual_image_url === null), "sku", (row) => row.sku);
    }),
    setManualImage: (id, sku, url) => reply(() => {
      const key = projectKey(id);
      const records = recordsByProject[key].slice(0, fixtures.skus.length);
      const record = records.find((row) => row.sku === sku);
      const targets = record ? [sku] : projectConfigs[key].sku_grouping?.enabled
        ? rowsByProject[key].filter((row) => row.parent_sku === sku).map((row) => row.sku)
        : [];
      for (const target of targets) {
        if (url) manualImages.set(id + ":" + target, url);
        else manualImages.delete(id + ":" + target);
      }
      const parent = targets.length > 0 ? imageRowsForQuery(id, true).rows.find((row) => row.sku === sku) : undefined;
      if (parent) return parent;
      const index = records.findIndex((row) => row.sku === sku);
      const currentRecord = records[index];
      const stock = rowsByProject[key].find((row) => row.sku === sku);
      const feed = index === 4 || index === 18 ? null : currentRecord ? mockFeedImageUrl(currentRecord) : null;
      return {
        sku, title: currentRecord?.title ?? sku, variant_title: currentRecord?.variant_title ?? null,
        stock_status: stock?.stock_status ?? "unknown", feed_image_url: feed,
        manual_image_url: url, used: url ? "manual" : feed ? "feed" : "none",
      };
    }),
    buildCommand: (_id, input: EdmCommandInput) => reply("edm-builder --theme \"" + input.theme + "\" --count " + input.count + (input.promo_code ? " --promo-code \"" + input.promo_code + "\"" : "")),
  };
}
