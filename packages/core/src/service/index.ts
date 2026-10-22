import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CSV_HEADERS,
  PATHS,
  dailyReportFile,
  eventsFile,
  isSiteIndexError,
  type DailySummaryRow,
  type InventoryEvent,
  type InventoryLatest,
  type InventorySummary,
  type ISODate,
  type ListQuery,
  type PageResult,
  type ProductDetails,
  type ProductFilters,
  type ProductFull,
  type ProductView,
  type ProjectDetail,
  type ProjectId,
  type ProjectSummary,
  type RunLog,
  type SeoIssue,
  type SeoPage,
  type SiteConfig,
  type SiteIndexApi,
  type SkuRecord,
  type SkuStockFilters,
  type SkuStockView,
  type StockStatus,
  type TagStat,
  type RunnerInfo,
  type SiteIndexError,
} from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { readCsv, writeCsv, type CsvRow } from "../io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../io/jsonl";
import { readRunner } from "../io/runner-lock";

export interface CoreServiceContext {
  resolveProject(id: ProjectId): string;
  deviceId: string;
  cacheDir: string;
}

/**
 * A8 首批实现的 core 方法。其余 API 方法随 weekly、ledger、validate 与 Job 模块接入。
 * 各方法的输入输出签名直接取自 SiteIndexApi。
 */
export interface CoreService {
  projects: Pick<SiteIndexApi["projects"], "get" | "updateConfig">;
  inventory: Pick<SiteIndexApi["inventory"], "summary" | "listSkus" | "dailyReport">;
  products: Pick<SiteIndexApi["products"], "list" | "get" | "setTags" | "listTags">;
  invalidate(projectPath: string): void;
}

interface ProjectSnapshot {
  projectPath: string;
  config: SiteConfig;
  runner: RunnerInfo | null;
  skus: SkuRecord[];
  latest: InventoryLatest[];
  dailySummary: DailySummaryRow[];
  events: InventoryEvent[];
  products: ProductView[];
  skuStock: SkuStockView[];
  productDetails: ProductDetails[];
  seoPages: SeoPage[];
  seoIssues: SeoIssue[];
  blogIndex: { url: string }[];
  runs: RunLog[];
  skuTags: CsvRow[];
  asOf: ISODate;
}

const PRODUCT_FIELDS = [
  "handle", "product_id", "title", "url", "category", "categories", "price_min", "price_max",
  "compare_at_max", "currency", "on_sale", "image_url", "image_source", "feed_image_url",
  "manual_image_url", "variant_count", "skus", "in_stock_variants", "stock_status", "stock_since",
  "tags", "priority", "exclude_edm", "last_featured", "days_since_featured", "first_seen", "status",
] as const;

const STOCK_STATUSES: readonly StockStatus[] = ["in_stock", "out_of_stock", "preorder", "unknown"];

function siteError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function localDate(timezone: string, now = new Date()): ISODate {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function monthFor(date: ISODate): string {
  return date.slice(0, 7);
}

function numberValue(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDailySummary(rows: CsvRow[]): DailySummaryRow[] {
  return rows.flatMap((row) => {
    if (!row.date || !row.category) return [];
    return [{
      date: row.date,
      category: row.category,
      total: numberValue(row.total),
      in_stock: numberValue(row.in_stock),
      out_of_stock: numberValue(row.out_of_stock),
      preorder: numberValue(row.preorder),
      unknown: numberValue(row.unknown),
    }];
  });
}

function countTotals(rows: readonly DailySummaryRow[]): DailySummaryRow {
  return rows.reduce<DailySummaryRow>((total, row) => ({
    date: total.date,
    category: "_all",
    total: total.total + row.total,
    in_stock: total.in_stock + row.in_stock,
    out_of_stock: total.out_of_stock + row.out_of_stock,
    preorder: total.preorder + row.preorder,
    unknown: total.unknown + row.unknown,
  }), { date: rows[0]?.date ?? "", category: "_all", total: 0, in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 });
}

function summaryTotals(rows: readonly DailySummaryRow[], date: ISODate): DailySummaryRow {
  const forDate = rows.filter((row) => row.date === date);
  return forDate.find((row) => row.category === "_all") ?? countTotals(forDate);
}

function parseEvents(rows: JsonRecord[]): InventoryEvent[] {
  return rows as unknown as InventoryEvent[];
}

async function readJsonlAs<T>(projectPath: string, relativePath: string): Promise<T[]> {
  return await readJsonl(path.join(projectPath, relativePath)) as unknown as T[];
}

async function readSiteConfig(projectPath: string): Promise<SiteConfig> {
  const configPath = path.join(projectPath, PATHS.site);
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw siteError("PROJECT_NOT_FOUND", "找不到项目配置文件", configPath);
    throw siteError("PROJECT_UNREADABLE", "无法读取项目配置文件", String(error));
  }
  try {
    return JSON.parse(content) as SiteConfig;
  } catch (error) {
    throw siteError("CONFIG_INVALID", "项目配置文件不是有效 JSON", String(error));
  }
}

async function loadSnapshot(projectPath: string): Promise<ProjectSnapshot> {
  const config = await readSiteConfig(projectPath);
  try {
    const [runner, skus, latest, dailyCsv, products, skuStock, productDetails, seoPages, seoIssues, blogIndex, runs, skuTags] = await Promise.all([
      readRunner(projectPath),
      readJsonlAs<SkuRecord>(projectPath, PATHS.skus),
      readJsonlAs<InventoryLatest>(projectPath, PATHS.inventoryLatest),
      readCsv(path.join(projectPath, PATHS.dailySummary)),
      readJsonlAs<ProductView>(projectPath, PATHS.productsView),
      readJsonlAs<SkuStockView>(projectPath, PATHS.skuStockView),
      readJsonlAs<ProductDetails>(projectPath, PATHS.productDetails),
      readJsonlAs<SeoPage>(projectPath, PATHS.seoPages),
      readJsonlAs<SeoIssue>(projectPath, PATHS.seoIssues),
      readJsonlAs<{ url: string }>(projectPath, PATHS.blogIndex),
      readJsonlAs<RunLog>(projectPath, PATHS.runs),
      readCsv(path.join(projectPath, PATHS.skuTags)),
    ]);
    const dailySummary = parseDailySummary(dailyCsv);
    const asOf = dailySummary.map((row) => row.date).sort(codeUnitCompare).at(-1) ?? localDate(config.timezone);
    const events = parseEvents(await readJsonl(path.join(projectPath, eventsFile(monthFor(asOf)))));
    return {
      projectPath,
      config,
      runner,
      skus,
      latest,
      dailySummary,
      events,
      products,
      skuStock,
      productDetails,
      seoPages,
      seoIssues,
      blogIndex,
      runs,
      skuTags,
      asOf,
    };
  } catch (error) {
    if (isSiteIndexError(error)) throw error;
    throw siteError("PROJECT_UNREADABLE", "无法读取项目数据文件", String(error));
  }
}

function compareValue(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right ? 0 : left ? 1 : -1;
  return codeUnitCompare(String(left), String(right));
}

function searchable(value: unknown): string {
  if (Array.isArray(value)) return value.map(searchable).join(" ");
  if (value === null || value === undefined) return "";
  return String(value).toLowerCase();
}

function paginate<T extends object>(
  rows: readonly T[],
  query: ListQuery<unknown>,
  searchFields: (row: T) => readonly unknown[],
  defaultSortField: string,
  defaultKey: (row: T) => string,
): PageResult<T> {
  const needle = query.search?.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((row) => searchFields(row).some((value) => searchable(value).includes(needle)))
    : [...rows];
  const field = query.sort?.field ?? defaultSortField;
  const direction = query.sort?.dir === "desc" ? -1 : 1;
  const sorted = [...filtered].sort((left, right) => {
    const a = (left as Record<string, unknown>)[field];
    const b = (right as Record<string, unknown>)[field];
    return compareValue(a, b) * direction || codeUnitCompare(defaultKey(left), defaultKey(right));
  });
  if (query.pageSize === 0) return { rows: sorted, total: sorted.length };
  const page = Math.max(1, Math.floor(query.page || 1));
  const pageSize = Math.max(1, Math.floor(query.pageSize || 20));
  const start = (page - 1) * pageSize;
  return { rows: sorted.slice(start, start + pageSize), total: sorted.length };
}

function tagsFor(row: ProductView): readonly string[] {
  return Array.isArray(row.tags) ? row.tags : [];
}

function todayCounts(events: readonly InventoryEvent[], date: ISODate): ProjectSummary["today"] {
  const result: ProjectSummary["today"] = { restock: 0, oos: 0, price: 0, new: 0, removed: 0 };
  for (const event of events) {
    if (event.date !== date) continue;
    if (event.type === "stock_change" && event.to === "in_stock") result.restock += 1;
    else if (event.type === "stock_change" && event.to === "out_of_stock") result.oos += 1;
    else if (event.type === "price_change") result.price += 1;
    else if (event.type === "new_sku" || event.type === "restored_sku") result.new += 1;
    else if (event.type === "removed_sku") result.removed += 1;
  }
  return result;
}

function projectSummary(snapshot: ProjectSnapshot, id: ProjectId, deviceId: string): ProjectSummary {
  const activeSkus = snapshot.skus.filter((row) => row.status === "active");
  const activeProducts = snapshot.products.filter((row) => row.status === "active");
  const productCount = activeProducts.length || new Set(activeSkus.map((row) => row.handle)).size;
  const latestBySku = new Map(snapshot.latest.map((row) => [row.sku, row]));
  const onlineRate = activeSkus.length
    ? activeSkus.filter((row) => latestBySku.get(row.sku)?.stock_status === "in_stock").length / activeSkus.length
    : null;
  const latestRun = [...snapshot.runs].sort((a, b) => codeUnitCompare(b.started_at, a.started_at))[0];
  const feeds = Array.isArray(snapshot.config.crawl.feed_url) ? snapshot.config.crawl.feed_url : [snapshot.config.crawl.feed_url];
  const warnings = feeds.some((feed) => typeof feed === "string" && feed.trim()) ? [] : ["尚未填写 GMC feed"];
  const runner = snapshot.runner;
  return {
    id,
    name: snapshot.config.brand.name || path.basename(snapshot.projectPath),
    path: snapshot.projectPath,
    domain: snapshot.config.domain,
    platform: snapshot.config.platform,
    sync: {
      state: latestRun?.status === "skipped" ? "partial" : latestRun?.status ?? "never",
      at: latestRun?.finished_at ?? latestRun?.started_at ?? null,
      job: latestRun?.job ?? null,
    },
    sku_count: activeSkus.length,
    product_count: productCount,
    online_rate: onlineRate,
    blog_count: snapshot.blogIndex.length,
    today: todayCounts(snapshot.events, snapshot.asOf),
    attention: snapshot.seoIssues.filter((issue) => issue.status === "open").length,
    warnings,
    runner_device: runner?.device_name ?? null,
    is_runner: runner?.device_id === deviceId,
  };
}

function inventoryEvents(snapshot: ProjectSnapshot): InventorySummary["today"] {
  const entries: InventorySummary["today"] = [];
  for (const event of snapshot.events) {
    if (event.date !== snapshot.asOf) continue;
    let type: InventorySummary["today"][number]["type"] | null = null;
    if (event.type === "stock_change" && event.to === "in_stock") type = "restock";
    else if (event.type === "stock_change" && event.to === "out_of_stock") type = "oos";
    else if (event.type === "price_change") type = "price";
    else if (event.type === "new_sku" || event.type === "restored_sku") type = "new";
    else if (event.type === "removed_sku") type = "removed";
    if (type) entries.push({
      type,
      sku: event.sku,
      title: event.title,
      detail: event.type === "stock_change" || event.type === "price_change" ? `${String(event.from)} → ${String(event.to)}` : undefined,
    });
  }
  return entries.sort((a, b) => codeUnitCompare(a.sku, b.sku) || codeUnitCompare(a.type, b.type));
}

function inventorySummary(snapshot: ProjectSnapshot, days: 14 | 30): InventorySummary {
  const dates = [...new Set(snapshot.dailySummary.map((row) => row.date))].sort(codeUnitCompare).slice(-days);
  const categories = [...new Set(snapshot.dailySummary.map((row) => row.category).filter((category) => category !== "_all"))].sort(codeUnitCompare);
  const byCategoryDate = new Map(snapshot.dailySummary.map((row) => [`${row.category}\u0000${row.date}`, row]));
  const trend = categories.map((category) => ({
    category,
    rates: dates.map((date) => {
      const row = byCategoryDate.get(`${category}\u0000${date}`);
      return row ? row.total ? row.in_stock / row.total : 0 : null;
    }),
  }));
  const totals = summaryTotals(snapshot.dailySummary, snapshot.asOf);
  const rate = totals.total ? totals.in_stock / totals.total : 0;
  const categoryRates = snapshot.dailySummary.filter((row) => row.date === snapshot.asOf && row.category !== "_all")
    .sort((a, b) => codeUnitCompare(a.category, b.category))
    .map((row) => ({ category: row.category, rate: row.total ? row.in_stock / row.total : 0, total: row.total }));
  return {
    as_of: snapshot.asOf,
    kpis: [
      { key: "total", label: "在售 SKU", value: String(totals.total) },
      { key: "in_stock", label: "有货 SKU", value: String(totals.in_stock), tone: "ok" },
      { key: "online_rate", label: "有货率", value: `${(rate * 100).toFixed(1)}%`, tone: rate > 0.8 ? "ok" : "warn" },
      { key: "out_of_stock", label: "缺货 SKU", value: String(totals.out_of_stock), tone: totals.out_of_stock ? "warn" : "ok" },
    ],
    trend: { dates, series: trend },
    category_rates: categoryRates,
    category_source: snapshot.config.categories?.mode ?? "feed",
    uncategorized: snapshot.skus.filter((row) => row.status === "active" && row.category === "uncategorized").length,
    today: inventoryEvents(snapshot),
  };
}

function filterProducts(rows: readonly ProductView[], filters: ProductFilters | undefined): ProductView[] {
  return rows.filter((row) => {
    if (filters?.stock === "in" && row.stock_status !== "in_stock") return false;
    if (filters?.stock === "out" && row.stock_status !== "out_of_stock") return false;
    if (filters?.stock === "other" && (row.stock_status === "in_stock" || row.stock_status === "out_of_stock")) return false;
    if (filters?.tag && !tagsFor(row).includes(filters.tag.toLowerCase())) return false;
    if (filters?.category && row.category !== filters.category && !row.categories.includes(filters.category)) return false;
    return true;
  });
}

function normalizedTags(tags: readonly string[]): string[] {
  return [...new Set(tags.flatMap((value) => value.split(";")).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
    .sort(codeUnitCompare);
}

function aggregateTags(skus: readonly SkuRecord[], tagRows: readonly CsvRow[], handle: string): Pick<ProductView, "tags" | "priority" | "exclude_edm"> {
  const active = skus.filter((sku) => sku.handle === handle && sku.status === "active");
  const selected = active.length ? active : skus.filter((sku) => sku.handle === handle);
  const rowBySku = new Map(tagRows.map((row) => [String(row.sku ?? ""), row]));
  const tags = new Set<string>();
  let priority: number | null = null;
  let excludeEdm: 0 | 1 = 0;
  for (const sku of selected) {
    const row = rowBySku.get(sku.sku);
    const values = typeof row?.tags === "string" ? row.tags.split(";") : [];
    for (const value of values) if (value.trim()) tags.add(value.trim().toLowerCase());
    const rawPriority = typeof row?.priority === "string" ? row.priority : "";
    if (rawPriority) {
      const parsed = Number.parseInt(rawPriority, 10);
      if (Number.isFinite(parsed)) priority = Math.max(priority ?? 0, parsed);
    }
    if (row?.exclude_edm === "1") excludeEdm = 1;
  }
  return { tags: [...tags].sort(codeUnitCompare), priority, exclude_edm: excludeEdm };
}

function setError(error: unknown): SiteIndexError {
  if (isSiteIndexError(error)) return error;
  return siteError("WRITE_FAILED", "写入项目数据失败", String(error));
}

export function createCoreService(ctx: CoreServiceContext): CoreService {
  const cache = new Map<string, Promise<ProjectSnapshot>>();
  const resolve = (id: ProjectId) => path.resolve(ctx.resolveProject(id));
  const invalidate = (projectPath: string) => { cache.delete(path.resolve(projectPath)); };

  const load = (projectPath: string): Promise<ProjectSnapshot> => {
    const key = path.resolve(projectPath);
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = loadSnapshot(key);
    cache.set(key, pending);
    void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };

  const projects: CoreService["projects"] = {
    get: async (id) => {
      const snapshot = await load(resolve(id));
      return { summary: projectSummary(snapshot, id, ctx.deviceId), config: snapshot.config, runner: snapshot.runner };
    },
    updateConfig: async (id, patch) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const config: SiteConfig = { ...snapshot.config, ...patch };
      try {
        await atomicWrite(path.join(projectPath, PATHS.site), `${JSON.stringify(config, null, 2)}\n`);
      } catch (error) {
        throw setError(error);
      }
      invalidate(projectPath);
      return config;
    },
  };

  const inventory: CoreService["inventory"] = {
    summary: async (id, days = 14) => inventorySummary(await load(resolve(id)), days),
    listSkus: async (id, query) => {
      const snapshot = await load(resolve(id));
      const filters = query.filters;
      const todaySkus = new Set(snapshot.events.filter((event) => event.date === snapshot.asOf).map((event) => event.sku));
      const rows = snapshot.skuStock.filter((row) => {
        if (filters?.status === "today" && !todaySkus.has(row.sku)) return false;
        if (filters?.status && filters.status !== "today" && row.stock_status !== filters.status) return false;
        if (filters?.category && row.category !== filters.category) return false;
        return true;
      });
      return paginate(rows, query, (row) => [row.sku, row.title, row.variant_title, row.category], "sku", (row) => row.sku);
    },
    dailyReport: async (id, date) => {
      const projectPath = resolve(id);
      await load(projectPath);
      try {
        return await readFile(path.join(projectPath, dailyReportFile(date)), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw siteError("PROJECT_UNREADABLE", "无法读取库存日报", String(error));
      }
    },
  };

  const products: CoreService["products"] = {
    list: async (id, query) => {
      const snapshot = await load(resolve(id));
      const rows = filterProducts(snapshot.products, query.filters);
      return paginate(rows, query, (row) => [row.handle, row.title, row.product_id, row.skus, row.category, row.categories, row.tags], "handle", (row) => row.handle);
    },
    get: async (id, handle): Promise<ProductFull> => {
      const snapshot = await load(resolve(id));
      const product = snapshot.products.find((row) => row.handle === handle);
      if (!product) throw siteError("UNKNOWN", "找不到指定产品", handle);
      const seoPage = snapshot.seoPages.find((row) => row.url === product.url);
      return {
        product,
        skus: snapshot.skus.filter((row) => row.handle === handle),
        details: snapshot.productDetails.find((row) => row.handle === handle) ?? null,
        seo: seoPage ? {
          url: seoPage.url,
          title: seoPage.title,
          robots_meta: seoPage.robots_meta,
          schema_types: seoPage.schema_types,
          google_indexed: seoPage.google_indexed,
        } : null,
      };
    },
    setTags: async (id, handle, inputTags) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      if (!snapshot.products.some((row) => row.handle === handle)) throw siteError("UNKNOWN", "找不到指定产品", handle);
      const activeSkus = snapshot.skus.filter((row) => row.handle === handle && row.status === "active");
      const selected = activeSkus.length ? activeSkus : snapshot.skus.filter((row) => row.handle === handle);
      const tags = normalizedTags(inputTags);
      const bySku = new Map(snapshot.skuTags.map((row) => [String(row.sku ?? ""), row]));
      const updatedAt = localDate(snapshot.config.timezone);
      for (const sku of selected) {
        const previous = bySku.get(sku.sku);
        bySku.set(sku.sku, {
          ...previous,
          sku: sku.sku,
          tags: tags.join(";") || null,
          priority: previous?.priority ?? null,
          exclude_edm: previous?.exclude_edm ?? "0",
          email_blurb: previous?.email_blurb ?? null,
          season: previous?.season ?? null,
          note: previous?.note ?? null,
          updated_at: updatedAt,
        });
      }
      const tagRows = [...bySku.values()];
      try {
        await writeCsv(path.join(projectPath, PATHS.skuTags), tagRows, CSV_HEADERS.skuTags, ["sku"]);
        const viewRows = await readJsonl(path.join(projectPath, PATHS.productsView));
        const view = viewRows.find((row) => row.handle === handle);
        if (view) {
          Object.assign(view, aggregateTags(snapshot.skus, tagRows, handle));
          await writeJsonl(path.join(projectPath, PATHS.productsView), viewRows, {
            primaryKey: ["handle"], fieldOrder: PRODUCT_FIELDS,
            floatFields: ["price_min", "price_max", "compare_at_max"],
          });
        }
      } catch (error) {
        invalidate(projectPath);
        throw setError(error);
      }
      invalidate(projectPath);
      return tags;
    },
    listTags: async (id) => {
      const snapshot = await load(resolve(id));
      const counts = new Map<string, number>();
      for (const product of snapshot.products) {
        for (const tag of new Set(tagsFor(product))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts].sort(([a], [b]) => codeUnitCompare(a, b)).map(([tag, count]) => ({ tag, products: count }));
    },
  };

  return { projects, inventory, products, invalidate };
}
