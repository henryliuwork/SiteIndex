import type { EdmCommandInput, EdmCampaignSafetyFinding, ListQuery, SkuImageFilters, SiteIndexApi } from "@siteindex/shared";
import { edmImageRows, fixtures, manualImages, mockFeedImageUrl, mockGalleryUrls, projectConfigs, projectKey, recordsByProject, reply, rowsByProject, selectRows } from "./context";

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
  const metadata = { sources: [{ kind: "mock", label: "虚构示例" }], collected_at: null, missing_fields: [], quality: "complete" as const, anomalies: [] };
  return {
    exportIndex: (_id) => reply({ status: "cancelled", sku_count: 0, missing_image_count: 0 }),
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
        manual_image_url: url, gallery_urls: mockGalleryUrls(sku, index),
        used: url ? "manual" : feed ? "feed" : "none",
      };
    }),
    buildCommand: (_id, input: EdmCommandInput) => reply("edm-builder --theme \"" + input.theme + "\" --count " + input.count + (input.promo_code ? " --promo-code \"" + input.promo_code + "\"" : "")),
    candidates: (id, query) => reply(() => {
      const key = projectKey(id);
      const records = new Map(recordsByProject[key].map((row) => [row.sku, row]));
      const rows = imageRowsForQuery(id, Boolean(query.parent_only)).rows
        .filter((row) => (query.stock === "any" || row.stock_status === "in_stock")
          && (!query.category || records.get(row.sku)?.category === query.category)
          && !query.tag)
        .map((row) => {
          const record = records.get(row.sku);
          return { sku: row.sku, title: row.title, category: record?.category ?? null, tags: [], stock_status: row.stock_status,
            price: record?.price ?? null, compare_at_price: record?.compare_at_price ?? null, currency: record?.currency ?? null,
            image_url: row.manual_image_url ?? row.feed_image_url,
            image_source: row.manual_image_url ? "manual" as const : row.feed_image_url ? "feed" as const : "none" as const,
            priority: null, last_featured: null, exclude_edm: false, discount_tier: null };
        });
      return { data: { rows: rows.slice(0, query.limit ?? rows.length), total: rows.length }, metadata };
    }),
    mediaGaps: (id, query) => reply(() => {
      const rows = imageRowsForQuery(id, Boolean(query.parent_only)).rows
        .filter((row) => (query.stock === "any" || row.stock_status === "in_stock")
          && (!query.skus || query.skus.includes(row.sku))
          && !row.feed_image_url && !row.manual_image_url)
        .map((row) => ({ sku: row.sku, title: row.title, stock_status: row.stock_status,
          reason: "missing" as const, feed_image_url: row.feed_image_url, manual_image_url: row.manual_image_url }));
      return { data: { rows: rows.slice(0, query.limit ?? rows.length), total: rows.length }, metadata };
    }),
    campaignSafety: (id, query) => reply(() => {
      const images = new Map(imageRowsForQuery(id, true).rows.concat(edmImageRows(id)).map((row) => [row.sku, row]));
      const seen = new Set<string>();
      const findings: EdmCampaignSafetyFinding[] = [];
      for (const sku of query.skus) {
        if (seen.has(sku)) findings.push({ code: "duplicate_sku", severity: "warning", sku, message: "SKU 重复选择。" });
        seen.add(sku);
        const row = images.get(sku);
        if (!row) findings.push({ code: "sku_not_found", severity: "blocker", sku, message: "项目中找不到该 SKU。" });
        else {
          if (row.stock_status === "out_of_stock") findings.push({ code: "out_of_stock", severity: "blocker", sku, message: "当前缺货。" });
          if (!row.feed_image_url && !row.manual_image_url) findings.push({ code: "missing_image", severity: "blocker", sku, message: "没有 EDM 可用图片。" });
        }
      }
      return { data: { scope: "local_product_data" as const, status: findings.some((row) => row.severity === "blocker") ? "blocked" as const : findings.length ? "needs_review" as const : "clear" as const,
        checked_skus: [...seen], findings }, metadata };
    }),
  };
}
