import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  PATHS,
  eventsFile,
  type EdmCampaign,
  type InventoryEvent,
  type InventoryLatest,
  type ISODate,
  type ProductView,
  type SiteConfig,
  type SkuGroupingRule,
  type SkuRecord,
  type SkuStockView,
  type StockStatus,
} from "@siteindex/shared";
import { readCsv, type CsvRow } from "../io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../io/jsonl";
import { groupSkuIds } from "../inventory/sku-grouping";

const PRODUCT_FIELDS = [
  "handle", "product_id", "title", "url", "category", "categories", "price_min", "price_max",
  "compare_at_max", "currency", "on_sale", "image_url", "image_source", "feed_image_url",
  "manual_image_url", "variant_count", "skus", "in_stock_variants", "stock_status", "stock_since",
  "tags", "priority", "exclude_edm", "last_featured", "days_since_featured", "first_seen", "status",
] as const;

const SKU_STOCK_FIELDS = [
  "sku", "title", "variant_title", "category", "price", "stock_status", "since", "days_in_status",
  "online_rate_7d", "online_rate_30d", "history_30d", "changes_30d", "last_change", "last_change_at", "parent_sku",
] as const;

const PRODUCT_FLOAT_FIELDS = ["price_min", "price_max", "compare_at_max"] as const;
const STOCK_FLOAT_FIELDS = ["price", "online_rate_7d", "online_rate_30d"] as const;

const STOCK_RANK: Record<StockStatus, number> = {
  in_stock: 0,
  preorder: 1,
  out_of_stock: 2,
  unknown: 3,
};

const STOCK_SYMBOL: Record<StockStatus, string> = {
  in_stock: "i",
  out_of_stock: "o",
  preorder: "p",
  unknown: "u",
};

const STOCK_STATUSES = Object.keys(STOCK_RANK) as StockStatus[];

export interface BuildViewsOptions {
  /** 用于黄金测试的固定日期；不传时按站点时区取今天。 */
  date?: ISODate;
  now?: Date;
}

export interface BuildViewsResult {
  products: number;
  skuStock: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dateInTimezone(now: Date, timezone: string): ISODate {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateAtOffset(date: ISODate, offset: number): ISODate {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

function isStockStatus(value: unknown): value is StockStatus {
  return typeof value === "string" && STOCK_STATUSES.includes(value as StockStatus);
}

function csvString(row: CsvRow | undefined, field: string): string | null {
  const value = row?.[field];
  return typeof value === "string" && value.length ? value : null;
}

function parseTags(value: string | null): string[] {
  return value ? value.split(";").map((tag) => tag.trim().toLowerCase()).filter(Boolean) : [];
}

export function buildProductViews(
  skuRows: readonly SkuRecord[],
  latestRows: readonly InventoryLatest[],
  mediaRows: readonly CsvRow[],
  tagRows: readonly CsvRow[],
  campaigns: readonly EdmCampaign[],
  today: ISODate,
): ProductView[] {
  const latest = new Map(latestRows.map((row) => [row.sku, row]));
  const media = new Map<string, Map<string, CsvRow>>();
  for (const row of mediaRows) {
    const sku = csvString(row, "sku");
    if (!sku) continue;
    const byRole = media.get(sku) ?? new Map<string, CsvRow>();
    byRole.set(csvString(row, "image_role") ?? "main", row);
    media.set(sku, byRole);
  }
  const tagsBySku = new Map<string, CsvRow>();
  for (const row of tagRows) {
    const sku = csvString(row, "sku");
    if (sku) tagsBySku.set(sku, row);
  }

  const featured = new Map<string, ISODate>();
  for (const campaign of campaigns) {
    const date = campaign.send_date || campaign.date;
    if (!date) continue;
    for (const handle of campaign.handles ?? []) {
      if (date > (featured.get(handle) ?? "")) featured.set(handle, date);
    }
  }

  const groups = new Map<string, SkuRecord[]>();
  for (const sku of skuRows) {
    const group = groups.get(sku.handle) ?? [];
    group.push(sku);
    groups.set(sku.handle, group);
  }

  const products: ProductView[] = [];
  for (const [handle, variants] of groups) {
    const allVariants = [...variants].sort((a, b) => compareText(a.sku, b.sku));
    const active = allVariants.filter((variant) => variant.status === "active");
    const selected = active.length ? active : allVariants;
    const lead = selected[0]!;
    const prices = selected.map((variant) => variant.price).filter((price): price is number => price !== null && price !== undefined);
    const comparePrices = selected.map((variant) => variant.compare_at_price).filter((price): price is number => Boolean(price));
    const statuses = selected.map((variant) => {
      const status = latest.get(variant.sku)?.stock_status;
      return isStockStatus(status) ? status : "unknown";
    });
    const stockStatus = [...statuses].sort((a, b) => STOCK_RANK[a] - STOCK_RANK[b])[0] ?? "unknown";
    const since = selected.flatMap((variant) => {
      const row = latest.get(variant.sku);
      return row?.stock_status === stockStatus && row.since ? [row.since] : [];
    }).sort(compareText)[0] ?? null;

    // 与 reference/scripts/build_views.py 一致：依 SKU 顺序取首个 feed 图，再取首个手动 main 图。
    const feedImage = selected.map((variant) => variant.image_url).find((image): image is string => Boolean(image)) ?? null;
    const manualImage = selected.map((variant) => csvString(media.get(variant.sku)?.get("main"), "image_url"))
      .find((image): image is string => Boolean(image)) ?? null;
    const imageSource = feedImage ? "feed" : manualImage ? "manual" : "none";
    const imageUrl = feedImage ?? manualImage;

    const productTags = new Set<string>();
    let priority: number | null = null;
    let excludeEdm: 0 | 1 = 0;
    for (const variant of selected) {
      const tagRow = tagsBySku.get(variant.sku);
      for (const tag of parseTags(csvString(tagRow, "tags"))) productTags.add(tag);
      const rawPriority = csvString(tagRow, "priority");
      if (rawPriority) {
        const parsed = Number.parseInt(rawPriority, 10);
        if (Number.isFinite(parsed)) priority = Math.max(priority ?? 0, parsed);
      }
      if (csvString(tagRow, "exclude_edm") === "1") excludeEdm = 1;
    }

    const lastFeatured = featured.get(handle) ?? null;
    products.push({
      handle,
      product_id: lead.product_id,
      title: lead.title,
      url: lead.url.split("?")[0]!,
      category: lead.category,
      categories: [...new Set(selected.flatMap((variant) => variant.categories ?? (variant.category ? [variant.category] : [])))].sort(compareText),
      price_min: prices.length ? Math.min(...prices) : null,
      price_max: prices.length ? Math.max(...prices) : null,
      compare_at_max: comparePrices.length ? Math.max(...comparePrices) : null,
      currency: lead.currency,
      on_sale: selected.some((variant) => Boolean(variant.compare_at_price && variant.price !== null && variant.compare_at_price > variant.price)),
      image_url: imageUrl,
      image_source: imageSource,
      feed_image_url: feedImage,
      manual_image_url: manualImage,
      variant_count: selected.length,
      skus: selected.map((variant) => variant.sku),
      in_stock_variants: statuses.filter((status) => status === "in_stock").length,
      stock_status: stockStatus,
      stock_since: since,
      tags: [...productTags].sort(compareText),
      priority,
      exclude_edm: excludeEdm,
      last_featured: lastFeatured,
      days_since_featured: lastFeatured ? daysBetween(lastFeatured, today) : null,
      first_seen: allVariants.map((variant) => variant.first_seen).sort(compareText)[0]!,
      status: active.length ? "active" : "removed",
    });
  }
  return products;
}

function monthRange(start: ISODate, end: ISODate): string[] {
  const months: string[] = [];
  let cursor = `${start.slice(0, 7)}-01`;
  const lastMonth = end.slice(0, 7);
  while (cursor.slice(0, 7) <= lastMonth) {
    months.push(cursor.slice(0, 7));
    cursor = dateAtOffset(cursor, 32).slice(0, 7) + "-01";
  }
  return months;
}

function symbolFor(status: StockStatus | null): string {
  return status ? STOCK_SYMBOL[status] : "-";
}

export function buildSkuStockViews(
  skuRows: readonly SkuRecord[],
  latestRows: readonly InventoryLatest[],
  allEvents: readonly InventoryEvent[],
  today: ISODate,
  groupingRule?: SkuGroupingRule,
): SkuStockView[] {
  const start = dateAtOffset(today, -29);
  const latest = new Map(latestRows.map((row) => [row.sku, row]));
  const recentBySku = new Map<string, InventoryEvent[]>();
  for (const event of allEvents) {
    if (event.date < start || event.date > today) continue;
    const list = recentBySku.get(event.sku) ?? [];
    list.push(event);
    recentBySku.set(event.sku, list);
  }

  const activeSkus = [...skuRows].filter((row) => row.status === "active").sort((a, b) => compareText(a.sku, b.sku));
  const parentByChild = groupingRule
    ? groupSkuIds(activeSkus.map((row) => row.sku), groupingRule).parentByChild
    : undefined;
  const views: SkuStockView[] = [];
  for (const sku of activeSkus) {
    const latestRow = latest.get(sku.sku);
    let state: StockStatus | null = isStockStatus(latestRow?.stock_status) ? latestRow.stock_status : "unknown";
    const events = [...(recentBySku.get(sku.sku) ?? [])].sort((a, b) => compareText(a.date, b.date) || compareText(a.type, b.type));
    const byDate = new Map<string, InventoryEvent[]>();
    for (const event of events) {
      const list = byDate.get(event.date) ?? [];
      list.push(event);
      byDate.set(event.date, list);
    }

    const history: string[] = [];
    const statesByDate = new Map<ISODate, StockStatus | null>();
    for (let offset = 0; offset < 30; offset += 1) {
      const day = dateAtOffset(today, -offset);
      statesByDate.set(day, day < sku.first_seen ? null : state);
      for (const event of [...(byDate.get(day) ?? [])].reverse()) {
        if (event.type === "stock_change" && isStockStatus(event.from)) state = event.from;
        else if (event.type === "new_sku" || event.type === "restored_sku") state = null;
        else if (event.type === "removed_sku") state = "unknown";
      }
    }
    for (let offset = 29; offset >= 0; offset -= 1) {
      const day = dateAtOffset(today, -offset);
      history.push(symbolFor(statesByDate.get(day) ?? null));
    }

    const currentStatus = isStockStatus(latestRow?.stock_status) ? latestRow.stock_status : "unknown";
    const since = latestRow?.since ?? sku.first_seen;
    const history7d = history.slice(-7);
    const history30d = history;
    const onlineRate = (states: readonly string[]) => {
      const availableDays = states.filter((value) => value !== "-");
      return availableDays.length ? availableDays.filter((value) => value === "i").length / availableDays.length : null;
    };
    const lastEvent = events.at(-1);
    views.push({
      sku: sku.sku,
      title: sku.title,
      variant_title: sku.variant_title,
      category: sku.category,
      price: sku.price,
      stock_status: currentStatus,
      since,
      days_in_status: Math.max(0, daysBetween(since, today) + 1),
      online_rate_7d: onlineRate(history7d),
      online_rate_30d: onlineRate(history30d),
      history_30d: history.join(""),
      changes_30d: events.length,
      last_change: lastEvent?.type ?? null,
      last_change_at: lastEvent?.date ?? null,
      ...(parentByChild?.has(sku.sku) ? { parent_sku: parentByChild.get(sku.sku) ?? null } : {}),
    });
  }
  return views;
}

export async function buildViews(projectPath: string, options: BuildViewsOptions = {}): Promise<BuildViewsResult> {
  const sitePath = path.join(projectPath, PATHS.site);
  const site = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
  const today = options.date ?? dateInTimezone(options.now ?? new Date(), site.timezone || "UTC");

  const [skuRows, latestRows, mediaRows, tagRows, campaigns, eventsByMonth] = await Promise.all([
    readJsonl(path.join(projectPath, PATHS.skus)),
    readJsonl(path.join(projectPath, PATHS.inventoryLatest)),
    readCsv(path.join(projectPath, PATHS.skuMedia)),
    readCsv(path.join(projectPath, PATHS.skuTags)),
    readJsonl(path.join(projectPath, PATHS.edmCampaigns)),
    Promise.all(monthRange(dateAtOffset(today, -29), today).map((month) => readJsonl(path.join(projectPath, eventsFile(month))))),
  ]);
  const skus = skuRows as unknown as SkuRecord[];
  const latest = latestRows as unknown as InventoryLatest[];
  const campaignRows = campaigns as unknown as EdmCampaign[];
  const events = eventsByMonth.flat() as unknown as InventoryEvent[];
  const products = buildProductViews(skus, latest, mediaRows, tagRows, campaignRows, today);
  const groupingRule = site.sku_grouping?.enabled ? site.sku_grouping.rule : undefined;
  const stock = buildSkuStockViews(skus, latest, events, today, groupingRule);

  await Promise.all([
    writeJsonl(path.join(projectPath, PATHS.productsView), products as unknown as JsonRecord[], {
      primaryKey: ["handle"], fieldOrder: PRODUCT_FIELDS, floatFields: PRODUCT_FLOAT_FIELDS,
    }),
    writeJsonl(path.join(projectPath, PATHS.skuStockView), stock as unknown as JsonRecord[], {
      primaryKey: ["sku"], fieldOrder: SKU_STOCK_FIELDS, floatFields: STOCK_FLOAT_FIELDS,
    }),
  ]);

  return { products: products.length, skuStock: stock.length };
}
