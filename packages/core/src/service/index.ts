import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CSV_HEADERS,
  DEFAULT_WORKSPACE_FOLDERS,
  EXIT,
  JOB_NAMES,
  PATHS,
  dailyReportFile,
  eventsFile,
  isSiteIndexError,
  type CreateProjectInput,
  type AttentionItem,
  type BlogFilters,
  type BlogPost,
  type CategoriesConfig,
  type Category,
  type CategoryPreview,
  type ContentSummary,
  type DesignTokens,
  type DraftRow,
  type DailySummaryRow,
  type DetectResult,
  type EdmCampaign,
  type EdmCommandInput,
  type FeedInspectResult,
  type FileCheck,
  type FolderRow,
  type InventoryEvent,
  type InventoryLatest,
  type InventorySummary,
  type ISODate,
  type Keyword,
  type KeywordFilters,
  type Kpi,
  type JobRequest,
  type JobResult,
  type ListQuery,
  type ManualCategory,
  type OverviewData,
  type PageResult,
  type ProgressReporter,
  type ProductDetails,
  type ProductFilters,
  type ProductFull,
  type ProductView,
  type ProjectDetail,
  type ProjectId,
  type ProjectSummary,
  type ReadmeData,
  type RepairAction,
  type RunLog,
  type RunnerState,
  type ScheduleState,
  type SeoIssueFilters,
  type SeoLink,
  type SeoIssue,
  type SeoPage,
  type SeoPageFilters,
  type SeoSummary,
  type SiteConfig,
  type SiteIndexApi,
  type SkuRecord,
  type SkuImageFilters,
  type SkuImageRow,
  type SkuStockFilters,
  type SkuStockView,
  type StockStatus,
  type TagStat,
  type RunnerInfo,
  type SiteIndexError,
  type ValidationReport,
} from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { readCsv, writeCsv, type CsvRow } from "../io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../io/jsonl";
import { FeedError, readFeeds, toSnapshot, type FeedSiteConfig } from "../crawl/gmc-feed";
import { runDaily } from "../jobs/daily";
import { buildViews } from "../views/build";
import { assertRunner, findConflictCopies, isConflictCopy, readRunner, withLock } from "../io/runner-lock";
import { createProjectFiles } from "../projects/create";
import { detectSite } from "../projects/detect";

export interface CoreServiceContext {
  resolveProject(id: ProjectId): string;
  deviceId: string;
  cacheDir: string;
  deviceName?: string;
  templateDir?: string;
}

/**
 * Core Service 只暴露 WORKSTREAMS §2 分配给 core 的能力；桌面专属方法留给 C。
 * 各方法的输入输出签名直接取自 SiteIndexApi。
 */
export interface CoreService {
  projects: Pick<SiteIndexApi["projects"], "get" | "updateConfig" | "detect" | "inspectFeed" | "create">;
  overview: SiteIndexApi["overview"];
  inventory: Pick<SiteIndexApi["inventory"], "summary" | "listSkus" | "dailyReport">;
  products: Pick<SiteIndexApi["products"], "list" | "get" | "setTags" | "listTags" | "createTag" | "deleteTag">;
  seo: Omit<SiteIndexApi["seo"], "checkIndex">;
  content: SiteIndexApi["content"];
  edm: SiteIndexApi["edm"];
  design: SiteIndexApi["design"];
  readme: SiteIndexApi["readme"];
  categories: SiteIndexApi["categories"];
  folders: Pick<SiteIndexApi["folders"], "list" | "create" | "describe">;
  files: SiteIndexApi["files"];
  schedule: SiteIndexApi["schedule"];
  runner: Pick<SiteIndexApi["runner"], "get">;
  runJob(req: JobRequest, report: ProgressReporter): Promise<JobResult>;
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
  seoLinks: SeoLink[];
  blogIndex: BlogPost[];
  keywords: Keyword[];
  skuMedia: CsvRow[];
  campaigns: EdmCampaign[];
  categories: Category[];
  runs: RunLog[];
  skuTags: CsvRow[];
  asOf: ISODate;
}

const PRODUCT_FIELDS = [
  "handle", "product_id", "title", "url", "category", "categories", "price_min", "price_max",
  "compare_at_max", "currency", "on_sale", "image_url", "image_source", "feed_image_url",
  "manual_image_url", "variant_count", "skus", "in_stock_variants", "stock_status", "stock_since",
  "tags", "priority", "exclude_edm", "email_blurb", "last_featured", "days_since_featured", "first_seen", "status",
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

async function readJsonAs<T>(projectPath: string, relativePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(projectPath, relativePath), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
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
    const parsed = JSON.parse(content) as Partial<SiteConfig>;
    const defaultSchedule: SiteConfig["schedule"] = {
      daily: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "02:00" },
      validate: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "02:30" },
      weekly: { enabled: true, days: [1], time: "03:00" },
      readme: { enabled: true, days: [7], time: "05:00" },
      monthly: { enabled: true, day_of_month: 1, time: "04:00" },
      options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: true },
    };
    const schedule = parsed.schedule;
    return {
      ...parsed,
      categories: parsed.categories ?? { mode: "feed" },
      workspace_folders: parsed.workspace_folders ?? DEFAULT_WORKSPACE_FOLDERS.map((name) => ({ name, default: true })),
      schedule: {
        ...defaultSchedule,
        ...schedule,
        daily: { ...defaultSchedule.daily, ...schedule?.daily },
        validate: { ...defaultSchedule.validate, ...schedule?.validate },
        weekly: { ...defaultSchedule.weekly, ...schedule?.weekly },
        readme: { ...defaultSchedule.readme, ...schedule?.readme },
        monthly: { ...defaultSchedule.monthly, ...schedule?.monthly },
        options: { ...defaultSchedule.options, ...schedule?.options },
      },
    } as SiteConfig;
  } catch (error) {
    throw siteError("CONFIG_INVALID", "项目配置文件不是有效 JSON", String(error));
  }
}

async function loadSnapshot(projectPath: string): Promise<ProjectSnapshot> {
  const config = await readSiteConfig(projectPath);
  try {
    const [runner, skus, latest, dailyCsv, products, skuStock, productDetails, seoPages, seoIssues, seoLinks, blogIndex, keywords, skuMedia, campaigns, categories, runs, skuTags] = await Promise.all([
      readRunner(projectPath),
      readJsonlAs<SkuRecord>(projectPath, PATHS.skus),
      readJsonlAs<InventoryLatest>(projectPath, PATHS.inventoryLatest),
      readCsv(path.join(projectPath, PATHS.dailySummary)),
      readJsonlAs<ProductView>(projectPath, PATHS.productsView),
      readJsonlAs<SkuStockView>(projectPath, PATHS.skuStockView),
      readJsonlAs<ProductDetails>(projectPath, PATHS.productDetails),
      readJsonlAs<SeoPage>(projectPath, PATHS.seoPages),
      readJsonlAs<SeoIssue>(projectPath, PATHS.seoIssues),
      readJsonlAs<SeoLink>(projectPath, PATHS.seoLinks),
      readJsonlAs<BlogPost>(projectPath, PATHS.blogIndex),
      readJsonlAs<Keyword>(projectPath, PATHS.keywords),
      readCsv(path.join(projectPath, PATHS.skuMedia)),
      readJsonlAs<EdmCampaign>(projectPath, PATHS.edmCampaigns),
      readJsonAs<Category[]>(projectPath, PATHS.categories, []),
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
      seoLinks,
      blogIndex,
      keywords,
      skuMedia,
      campaigns,
      categories,
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

const STOCK_STATUS_VALUES: readonly StockStatus[] = ["in_stock", "out_of_stock", "preorder", "unknown"];
const INSPECTED_FEED_FIELDS = ["title", "link", "price", "availability", "image_link", "brand", "product_type"] as const;

function feedBaseUrl(feedUrls: readonly string[]): string {
  for (const feedUrl of feedUrls) {
    try {
      const parsed = new URL(feedUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch { /* 本地 feed 没有站点 URL；使用不可路由的基准域名解析相对链接 */ }
  }
  return "https://siteindex.invalid";
}

async function inspectFeeds(feedUrls: string[], opts: { sku_field: string; category_depth: number }): Promise<FeedInspectResult> {
  try {
    const site: FeedSiteConfig = {
      base_url: feedBaseUrl(feedUrls),
      timezone: "UTC",
      crawl: { feed_url: feedUrls, sku_field: opts.sku_field || "id", category_depth: opts.category_depth },
    };
    const items = await readFeeds(site);
    const snapshot = toSnapshot(items, site, localDate("UTC"));
    const stock = Object.fromEntries(STOCK_STATUS_VALUES.map((status) => [status, snapshot.stats[status] ?? 0])) as Record<StockStatus, number>;
    const present = (value: unknown): boolean => value !== undefined && value !== null && String(value).trim() !== "";
    const field_coverage = [opts.sku_field || "id", ...INSPECTED_FEED_FIELDS]
      .filter((field, index, all) => all.indexOf(field) === index)
      .map((field) => ({ field, pct: items.length ? Math.round(items.filter((item) => present(item[field])).length * 1000 / items.length) / 10 : 0 }));
    const categories = new Map<string, number>();
    for (const row of snapshot.rows) categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
    const samples = snapshot.rows.slice(0, 5).map((row) => ({
      sku: row.sku,
      title: row.title,
      variant_title: row.variant_title,
      category: row.category,
      price: row.price,
      stock_status: row.stock_status,
    }));
    return {
      items: items.length,
      usable_skus: snapshot.rows.length,
      products: new Set(snapshot.rows.map((row) => row.handle)).size,
      skipped: {
        duplicate: snapshot.stats.duplicate ?? 0,
        missing_price_or_link: snapshot.stats.missing_price_or_link ?? 0,
        no_id: snapshot.stats.no_id ?? 0,
      },
      stock,
      field_coverage,
      category_distribution: [...categories].sort(([left], [right]) => codeUnitCompare(left, right))
        .map(([slug, count]) => ({ slug, count })),
      samples,
    };
  } catch (error) {
    if (error instanceof FeedError) throw siteError(error.code, error.message);
    if (isSiteIndexError(error)) throw error;
    throw siteError("FEED_FETCH_FAILED", "读取或解析 feed 失败", error instanceof Error ? error.message : String(error));
  }
}

function zonedTimestamp(timezone: string, date = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName ?? "GMT+00:00").replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function jobFailure(req: JobRequest, runId: string, exitCode: number, summary: string, errors: string[]): JobResult {
  return { runId, job: req.job, status: "failed", exitCode, summary, errors };
}

function thrownExitCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number") return error.exitCode;
  if (isSiteIndexError(error)) {
    if (error.code === "LOCKED") return EXIT.LOCKED;
    if (error.code === "NOT_RUNNER") return EXIT.NOT_RUNNER;
    if (error.code === "FEED_FETCH_FAILED" || error.code === "FEED_EMPTY") return EXIT.SOURCE_FAILED;
    if (error.code === "CONFIG_INVALID" || error.code === "PATH_OUTSIDE_PROJECT") return EXIT.VALIDATION_FAILED;
  }
  return EXIT.VALIDATION_FAILED;
}

async function appendRunLog(projectPath: string, record: RunLog): Promise<void> {
  const filePath = path.join(projectPath, PATHS.runs);
  const rows = await readJsonl(filePath);
  const next = rows.filter((row) => row.run_id !== record.run_id);
  next.push(record as unknown as JsonRecord);
  await writeJsonl(filePath, next, "run_log");
}

function extractReadmeSection(markdown: string, title: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end]!)) end += 1;
  return lines.slice(start + 1, end).join("\n").trim();
}

function readmeUserBlocks(markdown: string): ReadmeData["user_blocks"] {
  return {
    overview: extractReadmeSection(markdown, "项目概况"),
    focus: extractReadmeSection(markdown, "当前重点"),
    rules: extractReadmeSection(markdown, "工作规则与偏好"),
  };
}

function replaceReadmeSection(markdown: string, title: string, content: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return markdown;
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end]!)) end += 1;
  lines.splice(start + 1, end - start - 1, content.trim(), "");
  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

async function describeFolder(projectPath: string, name: string, isDefault: boolean): Promise<FolderRow> {
  const folderPath = path.join(projectPath, name);
  let description = "待补充说明";
  let modifiedAt: string | null = null;
  let files = 0;
  try {
    const info = await stat(folderPath);
    modifiedAt = info.mtime.toISOString();
    const aboutPath = path.join(folderPath, PATHS.aboutFile);
    try {
      const about = (await readFile(aboutPath, "utf8")).replace(/<!--[\s\S]*?-->/g, "");
      const paragraph = about.trim().split(/\r?\n\s*\r?\n/, 1)[0]?.trim();
      if (paragraph) description = paragraph.replace(/\r?\n/g, " ").trim();
    } catch { /* 缺少 _about.md 时显示待补充说明 */ }
    const count = async (directory: string): Promise<number> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      let total = 0;
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) total += await count(path.join(directory, entry.name));
        else if (entry.name !== PATHS.aboutFile) total += 1;
      }
      return total;
    };
    files = await count(folderPath);
  } catch { /* 文件夹尚未创建 */ }
  return { name, description, default: isDefault, files, modified_at: modifiedAt };
}

async function listProjectFolders(projectPath: string, config: SiteConfig): Promise<FolderRow[]> {
  return await Promise.all(config.workspace_folders.map((folder) => describeFolder(projectPath, folder.name, folder.default)));
}

function categorySlug(value: string): string {
  return value.toLowerCase().trim().replaceAll("&", " and ").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "uncategorized";
}

function matchManualCategory(sku: SkuRecord, category: ManualCategory): boolean {
  return (category.match ?? []).some((rule) => {
    if (rule.type === "product_type_contains") return (sku.category ?? "").toLowerCase().includes(rule.value.toLowerCase());
    if (rule.type === "sku_prefix") return sku.sku.toLowerCase().startsWith(rule.value.toLowerCase());
    if (rule.type === "url_contains") return sku.url.toLowerCase().includes(rule.value.toLowerCase());
    return rule.value.split(/[;,]/).map((value) => value.trim()).includes(sku.sku);
  });
}

function urlRuleCategory(skuUrl: string, patterns: string): { slug: string; url: string } | null {
  let url: URL;
  try { url = new URL(skuUrl); } catch { return null; }
  for (const pattern of patterns.split(",").map((value) => value.trim()).filter(Boolean)) {
    const escaped = pattern.split("{slug}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([^/]+)");
    const match = new RegExp(`^${escaped}/?$`, "i").exec(url.pathname);
    if (match?.[1]) return { slug: categorySlug(decodeURIComponent(match[1])), url: `${url.origin}${url.pathname}` };
  }
  return null;
}

function categoryPreview(snapshot: ProjectSnapshot, config: CategoriesConfig): CategoryPreview {
  const activeSkus = snapshot.skus.filter((sku) => sku.status === "active");
  const counts = new Map<string, { name: string; url: string; sku_count: number }>();
  let uncategorized = 0;
  let multiMatched = 0;
  for (const sku of activeSkus) {
    let matches: { slug: string; name: string; url: string }[] = [];
    if (config.mode === "feed") {
      const categories = sku.categories?.length ? sku.categories : [sku.category || "uncategorized"];
      matches = categories.map((slug) => ({ slug, name: slug, url: "" }));
    } else if (config.mode === "manual") {
      matches = (config.manual ?? []).filter((category) => matchManualCategory(sku, category))
        .map((category) => ({ slug: category.slug, name: category.name, url: category.url }));
    } else {
      const result = urlRuleCategory(sku.url, config.url_pattern ?? "");
      if (result) matches = [{ ...result, name: result.slug }];
    }
    if (matches.length > 1) multiMatched += 1;
    if (!matches.length) { uncategorized += 1; continue; }
    for (const match of matches) {
      const current = counts.get(match.slug) ?? { name: match.name, url: match.url, sku_count: 0 };
      current.sku_count += 1;
      if (!current.url && match.url) current.url = match.url;
      counts.set(match.slug, current);
    }
  }
  const configuredUrls = new Set((config.manual ?? []).map((category) => category.url).filter(Boolean));
  const candidates = snapshot.seoPages.filter((page) => page.page_type === "collection").map((page) => ({
    url: page.url,
    product_links: snapshot.seoLinks.filter((link) => link.from === page.url && link.to_type === "product").length,
    configured: configuredUrls.has(page.url),
  })).sort((a, b) => codeUnitCompare(a.url, b.url));
  return {
    categories: [...counts].sort(([a], [b]) => codeUnitCompare(a, b)).map(([slug, row]) => ({ slug, ...row })),
    uncategorized,
    multi_matched: multiMatched,
    candidates,
  };
}

function applyCategoryConfig(skus: SkuRecord[], config: CategoriesConfig): SkuRecord[] {
  return skus.map((sku) => {
    if (config.mode === "feed") {
      const categories = sku.categories?.length ? [...sku.categories] : [sku.category || "uncategorized"];
      return { ...sku, categories, category: categories[0] ?? "uncategorized", category_source: "feed" };
    }
    if (config.mode === "manual") {
      const matches = (config.manual ?? []).filter((category) => matchManualCategory(sku, category));
      const categories = matches.map((category) => category.slug);
      return { ...sku, categories, category: categories[0] ?? "uncategorized", category_source: categories.length ? "manual" : "none" };
    }
    const match = urlRuleCategory(sku.url, config.url_pattern ?? "");
    return { ...sku, categories: match ? [match.slug] : [], category: match?.slug ?? "uncategorized", category_source: match ? "url_rule" : "none" };
  });
}

function readmeAutoContent(snapshot: ProjectSnapshot, folders: readonly FolderRow[]): Record<string, string> {
  const activeSkus = snapshot.skus.filter((sku) => sku.status === "active").length;
  const activeProducts = snapshot.products.filter((product) => product.status === "active").length;
  const latestRuns = [...snapshot.runs].sort((a, b) => codeUnitCompare(b.started_at, a.started_at)).slice(0, 8);
  return {
    "index-summary": [
      `- 网站：${snapshot.config.domain}（${snapshot.config.platform}）`,
      `- 在售产品：${activeProducts}；在售 SKU：${activeSkus}`,
      `- 数据日期：${snapshot.asOf}`,
    ].join("\n"),
    "folder-map": folders.length ? folders.map((folder) => `- **${folder.name}**：${folder.description}`).join("\n") : "待创建工作区文件夹。",
    "task-routing": "- 库存与产品数据：读取 `index/views/`。\n- SEO 与内容数据：读取 `index/seo/` 和 `index/content/`。\n- 内容、EDM、设计成果：写入对应工作区文件夹。",
    "data-guide": "- `index/` 由 SiteIndex 维护；台账通过软件或 `siteindex ledger` 修改。\n- 数据结构与字段以项目配置和 SiteIndex 数据规范为准。",
    "design-summary": snapshot.config.platform ? `- 平台：${snapshot.config.platform}\n- 设计数据：${snapshot.config.domain}` : "尚未生成设计数据。",
    changelog: latestRuns.length ? latestRuns.map((run) => `- ${run.started_at.slice(0, 10)} · ${run.job} · ${run.status}`).join("\n") : "暂无同步记录。",
  };
}

async function refreshReadmeFile(projectPath: string, snapshot: ProjectSnapshot): Promise<void> {
  let markdown = await readFile(path.join(projectPath, PATHS.readme), "utf8").catch(() => "# 项目说明\n");
  const folders = await listProjectFolders(projectPath, snapshot.config);
  const blocks = readmeAutoContent(snapshot, folders);
  const disabled = new Set<string>(snapshot.config.readme?.disabled_blocks ?? []);
  for (const [id, body] of Object.entries(blocks)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockPattern = new RegExp(`(<!-- siteindex:auto:start id=\"${escaped}\" -->)[\\s\\S]*?(<!-- siteindex:auto:end id=\"${escaped}\" -->)`, "m");
    const match = blockPattern.exec(markdown);
    if (match) {
      markdown = markdown.replace(blockPattern, `${match[1]}\n${body}\n${match[2]}`);
    } else if (!disabled.has(id)) {
      markdown = `${markdown.trimEnd()}\n\n<!-- siteindex:auto:start id=\"${id}\" -->\n${body}\n<!-- siteindex:auto:end id=\"${id}\" -->\n`;
    }
  }
  await atomicWrite(path.join(projectPath, PATHS.readme), markdown);
}

function setFirstParagraph(markdown: string, description: string): string {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && (!lines[start]!.trim() || lines[start]!.trim().startsWith("<!--"))) start += 1;
  let end = start;
  while (end < lines.length && lines[end]!.trim()) end += 1;
  const replacement = description.trim() || "待补充说明";
  if (start === lines.length) return `${markdown.trimEnd()}\n${replacement}\n`;
  lines.splice(start, end - start, replacement);
  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

export function createCoreService(ctx: CoreServiceContext): CoreService {
  const cache = new Map<string, Promise<ProjectSnapshot>>();
  const createdTags = new Map<string, Set<string>>();
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

  const runJob: CoreService["runJob"] = async (req, report) => {
    const projectPath = path.resolve(req.projectPath);
    let config: SiteConfig;
    let requestedDate = req.date;
    try {
      await access(projectPath);
      config = await readSiteConfig(projectPath);
      if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return jobFailure(req, `${requestedDate}-${req.job}`, EXIT.BAD_ARGS, "Job 日期格式无效。", [requestedDate]);
      }
      requestedDate ??= localDate(config.timezone);
    } catch (error) {
      return jobFailure(req, `${new Date().toISOString().slice(0, 10)}-${req.job}`, thrownExitCode(error),
        isSiteIndexError(error) ? error.message : "项目不可读。", [error instanceof Error ? error.message : String(error)]);
    }
    const runId = `${requestedDate}-${req.job}`;
    if (!(JOB_NAMES as readonly string[]).includes(req.job)) {
      return jobFailure(req, runId, EXIT.BAD_ARGS, "不支持的 Job。", [String(req.job)]);
    }

    try {
      // 定时设备检查必须先于锁文件和 runs 写入，非执行设备不修改项目。
      await assertRunner(projectPath, ctx.deviceId, req.trigger);
    } catch (error) {
      const code = thrownExitCode(error);
      const message = isSiteIndexError(error) ? error.message : "无法检查项目执行设备。";
      if (code === EXIT.NOT_RUNNER) return { runId, job: req.job, status: "skipped", exitCode: code, summary: message };
      return jobFailure(req, runId, code, message, [message]);
    }

    const startedAt = zonedTimestamp(config.timezone);
    let tempRoot: string | null = null;
    const progress = (pct: number | null, step: string, message: string, level: "info" | "warn" | "error" = "info") => {
      report({ pct, step, level, message });
    };

    try {
      const result = await withLock(projectPath, async (): Promise<JobResult> => {
        let executionPath = projectPath;
        if (req.dryRun) {
          tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-dry-run-"));
          executionPath = path.join(tempRoot, "project");
          await cp(projectPath, executionPath, { recursive: true, force: false, errorOnExist: false });
        }

        let jobResult: JobResult;
        if (req.job === "daily") {
          progress(5, "feed", "正在读取商品 feed");
          const items = await readFeeds(config as FeedSiteConfig);
          const snapshot = toSnapshot(items, config as FeedSiteConfig, requestedDate).rows;
          progress(35, "daily", "正在合并商品与库存数据");
          const daily = await runDaily(executionPath, snapshot, { date: requestedDate, force: req.force });
          if (daily.status !== "failed") {
            progress(80, "views", "正在生成产品与库存视图");
            await buildViews(executionPath, { date: requestedDate });
          }
          jobResult = {
            runId,
            job: req.job,
            status: daily.status,
            exitCode: daily.exitCode,
            summary: daily.status === "failed" ? "每日同步失败。" : daily.status === "partial" ? "每日同步完成，包含库存未知项。" : "每日同步完成。",
            counts: daily.counts,
            ...(daily.errors.length ? { errors: daily.errors } : {}),
          };
        } else if (req.job === "views") {
          progress(10, "views", "正在重新生成数据视图");
          const built = await buildViews(executionPath, { date: requestedDate });
          jobResult = {
            runId, job: req.job, status: "ok", exitCode: EXIT.OK, summary: "数据视图已更新。",
            counts: { products: built.products, sku_stock: built.skuStock },
          };
        } else if (req.job === "readme") {
          progress(20, "readme", "正在刷新 README 自动区块");
          await refreshReadmeFile(executionPath, await load(executionPath));
          jobResult = { runId, job: req.job, status: "ok", exitCode: EXIT.OK, summary: "README 已更新。" };
        } else {
          const message = `Job「${req.job}」尚未接入 core 执行器。`;
          jobResult = jobFailure(req, runId, EXIT.SOURCE_FAILED, message, [message]);
        }

        if (!req.dryRun) {
          const existing = (await readJsonl(path.join(executionPath, PATHS.runs))).find((row) => row.run_id === runId);
          const record: RunLog = {
            run_id: runId,
            job: req.job,
            trigger: req.trigger,
            device_name: ctx.deviceName ?? (await readRunner(projectPath))?.device_name ?? "SiteIndex",
            started_at: typeof existing?.started_at === "string" ? existing.started_at : startedAt,
            finished_at: zonedTimestamp(config.timezone),
            status: jobResult.status === "skipped" ? "failed" : jobResult.status,
            ...(jobResult.counts ? { counts: jobResult.counts } : {}),
            ...(jobResult.errors ? { errors: jobResult.errors } : {}),
          };
          await appendRunLog(projectPath, record);
        }
        return jobResult;
      }, { deviceId: ctx.deviceId, deviceName: ctx.deviceName, job: req.job });
      if (result.status === "ok" || result.status === "partial") progress(100, "done", result.summary);
      else progress(null, "done", result.summary, "error");
      return result;
    } catch (error) {
      const exitCode = thrownExitCode(error);
      const message = isSiteIndexError(error) ? error.message : error instanceof Error ? error.message : String(error);
      if (exitCode === EXIT.LOCKED || exitCode === EXIT.NOT_RUNNER) {
        return { runId, job: req.job, status: "skipped", exitCode, summary: message, errors: [message] };
      }
      const failed = jobFailure(req, runId, exitCode, "Job 执行失败。", [message]);
      try {
        await appendRunLog(projectPath, {
          run_id: runId, job: req.job, trigger: req.trigger,
          device_name: ctx.deviceName ?? "SiteIndex", started_at: startedAt,
          finished_at: zonedTimestamp(config.timezone), status: "failed", errors: [message],
        });
      } catch { /* 项目不可写时保留可返回的 JobResult */ }
      progress(null, "failed", message, "error");
      return failed;
    } finally {
      invalidate(projectPath);
      if (tempRoot) {
        invalidate(path.join(tempRoot, "project"));
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
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
    detect: detectSite,
    inspectFeed: inspectFeeds,
    create: async (input: CreateProjectInput) => {
      const detected = await detectSite(input.url);
      const created = await createProjectFiles(input, detected, ctx.templateDir);
      invalidate(created.path);
      const job = await runJob({ projectPath: created.path, job: "daily", trigger: "manual" }, () => undefined);
      return { id: created.id, runId: job.runId };
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
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const counts = new Map<string, number>();
      for (const product of snapshot.products) {
        for (const tag of new Set(tagsFor(product))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      for (const tag of createdTags.get(projectPath) ?? []) if (!counts.has(tag)) counts.set(tag, 0);
      return [...counts].sort(([a], [b]) => codeUnitCompare(a, b)).map(([tag, count]) => ({ tag, products: count }));
    },
    createTag: async (id, tag) => {
      const normalized = normalizedTags([tag])[0];
      if (!normalized) throw siteError("UNKNOWN", "标签不能为空。");
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const counts = new Map<string, number>();
      for (const product of snapshot.products) for (const current of new Set(tagsFor(product))) counts.set(current, (counts.get(current) ?? 0) + 1);
      const created = createdTags.get(projectPath) ?? new Set<string>();
      created.add(normalized);
      createdTags.set(projectPath, created);
      if (!counts.has(normalized)) counts.set(normalized, 0);
      return [...counts].sort(([a], [b]) => codeUnitCompare(a, b)).map(([name, products]) => ({ tag: name, products }));
    },
    deleteTag: async (id, tag) => {
      const normalized = tag.trim().toLowerCase();
      const projectPath = resolve(id);
      createdTags.get(projectPath)?.delete(normalized);
      const snapshot = await load(projectPath);
      const changed = snapshot.skuTags.map((row) => ({ ...row }));
      for (const row of changed) {
        if (typeof row.tags !== "string") continue;
        row.tags = row.tags.split(";").map((value) => value.trim().toLowerCase()).filter((value) => value && value !== normalized).join(";") || null;
      }
      try {
        await writeCsv(path.join(projectPath, PATHS.skuTags), changed, CSV_HEADERS.skuTags, ["sku"]);
        const viewRows = await readJsonl(path.join(projectPath, PATHS.productsView));
        for (const view of viewRows) {
          if (typeof view.handle === "string") Object.assign(view, aggregateTags(snapshot.skus, changed, view.handle));
        }
        await writeJsonl(path.join(projectPath, PATHS.productsView), viewRows, {
          primaryKey: ["handle"], fieldOrder: PRODUCT_FIELDS,
          floatFields: ["price_min", "price_max", "compare_at_max"],
        });
      } catch (error) {
        throw setError(error);
      }
      invalidate(projectPath);
      const refreshed = await load(projectPath);
      const counts = new Map<string, number>();
      for (const product of refreshed.products) for (const current of new Set(tagsFor(product))) counts.set(current, (counts.get(current) ?? 0) + 1);
      return [...counts].sort(([a], [b]) => codeUnitCompare(a, b)).map(([name, products]) => ({ tag: name, products }));
    },
  };

  const overview: CoreService["overview"] = {
    get: async (id): Promise<OverviewData> => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const readme = await readFile(path.join(projectPath, PATHS.readme), "utf8").catch(() => "");
      const userBlocks = readmeUserBlocks(readme);
      const activeSkus = snapshot.skus.filter((row) => row.status === "active").length;
      const activeProducts = snapshot.products.filter((row) => row.status === "active").length;
      const openIssues = snapshot.seoIssues.filter((issue) => issue.status === "open");
      const rate = activeSkus ? snapshot.latest.filter((row) => row.stock_status === "in_stock").length / activeSkus : null;
      const kpis: Kpi[] = [
        { key: "products", label: "在售产品", value: String(activeProducts || new Set(snapshot.skus.filter((row) => row.status === "active").map((row) => row.handle)).size) },
        { key: "skus", label: "在售 SKU", value: String(activeSkus) },
        { key: "online_rate", label: "有货率", value: rate === null ? "—" : `${(rate * 100).toFixed(1)}%`, tone: rate !== null && rate > 0.8 ? "ok" : "warn" },
        { key: "attention", label: "待处理 SEO 问题", value: String(openIssues.length), tone: openIssues.length ? "warn" : "ok" },
      ];
      const attention: AttentionItem[] = openIssues.slice(0, 6).map((issue) => ({
        severity: issue.severity, text: `${issue.rule}：${issue.detail}`, link: issue.url, link_label: "查看 SEO 问题",
      }));
      const feeds = Array.isArray(snapshot.config.crawl.feed_url) ? snapshot.config.crawl.feed_url : [snapshot.config.crawl.feed_url];
      if (!feeds.some((feed) => typeof feed === "string" && feed.trim())) {
        attention.unshift({ severity: "mid", text: "尚未填写 GMC feed", link: `/p/${id}/settings`, link_label: "配置 feed" });
      }
      const changelog = [...snapshot.runs].sort((a, b) => codeUnitCompare(b.started_at, a.started_at)).slice(0, 8)
        .map((run) => ({ date: run.started_at.slice(0, 10), text: `${run.job} · ${run.status}` }));
      return {
        kpis,
        attention,
        readme: { overview: userBlocks.overview, focus: userBlocks.focus },
        agent_instruction: `进入 ${path.basename(projectPath)} 后，先完整阅读 README.md，再按任务读取对应 index/ 数据。`,
        changelog,
      };
    },
  };

  const seo: CoreService["seo"] = {
    summary: async (id): Promise<SeoSummary> => {
      const snapshot = await load(resolve(id));
      const open = snapshot.seoIssues.filter((issue) => issue.status === "open");
      const crawled = snapshot.seoPages.map((page) => page.last_crawled).sort(codeUnitCompare).at(-1);
      const titleRange = snapshot.config.seo?.title_range ?? [30, 60];
      const descriptionRange = snapshot.config.seo?.description_range ?? [120, 160];
      return {
        kpis: [
          { key: "pages", label: "抓取页面", value: String(snapshot.seoPages.length) },
          { key: "indexable", label: "可收录页面", value: String(snapshot.seoPages.filter((page) => page.indexable).length) },
          { key: "issues", label: "开放问题", value: String(open.length), tone: open.length ? "warn" : "ok" },
          { key: "high", label: "高优先级", value: String(open.filter((issue) => issue.severity === "high").length), tone: "danger" },
        ],
        crawled_at: crawled ? `${crawled}T00:00:00.000Z` : null,
        title_range: [...titleRange] as [number, number],
        description_range: [...descriptionRange] as [number, number],
      };
    },
    listIssues: async (id, query) => {
      const snapshot = await load(resolve(id));
      const rows = snapshot.seoIssues.filter((issue) => (!query.filters?.severity || issue.severity === query.filters.severity)
        && (!query.filters?.status || issue.status === query.filters.status));
      return paginate(rows, query, (row) => [row.url, row.rule, row.detail, row.severity, row.status], "severity", (row) => `${row.url}\u0000${row.rule}`);
    },
    listPages: async (id, query) => {
      const snapshot = await load(resolve(id));
      const rows = snapshot.seoPages.filter((page) => {
        if (query.filters?.page_type && page.page_type !== query.filters.page_type) return false;
        if (query.filters?.indexed === "yes" && page.google_indexed !== true) return false;
        if (query.filters?.indexed === "no" && page.google_indexed !== false) return false;
        if (query.filters?.indexed === "unchecked" && page.google_indexed !== null && page.google_indexed !== undefined) return false;
        return true;
      });
      return paginate(rows, query, (row) => [row.url, row.title, row.meta_description, row.page_type], "url", (row) => row.url);
    },
    listLinks: async (id, query) => {
      const snapshot = await load(resolve(id));
      return paginate(snapshot.seoLinks, query, (row) => [row.from, row.to, row.anchor, row.to_type], "from", (row) => `${row.from}\u0000${row.to}\u0000${row.anchor}`);
    },
    orphanPages: async (id) => {
      const snapshot = await load(resolve(id));
      return snapshot.seoPages.filter((page) => page.indexable && (page.links_internal_in ?? 0) === 0)
        .map((page) => page.url).sort(codeUnitCompare);
    },
    getPage: async (id, url) => (await load(resolve(id))).seoPages.find((page) => page.url === url) ?? null,
    googleSiteUrl: async (url) => {
      let parsed: URL;
      try { parsed = new URL(url.includes("://") ? url : `https://${url}`); }
      catch { throw siteError("UNKNOWN", "网站地址无效。", url); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw siteError("UNKNOWN", "网站地址必须使用 HTTP 或 HTTPS。", url);
      return `https://www.google.com/search?q=${encodeURIComponent(`site:${parsed.hostname}${parsed.pathname}`)}`;
    },
  };

  const content: CoreService["content"] = {
    summary: async (id): Promise<ContentSummary> => {
      const snapshot = await load(resolve(id));
      const keywords = new Set(snapshot.keywords.map((row) => row.keyword.toLowerCase()));
      const uncovered = (snapshot.config.seo?.core_keywords ?? []).filter((keyword) => !keywords.has(keyword.toLowerCase()));
      return {
        kpis: [
          { key: "blogs", label: "博客文章", value: String(snapshot.blogIndex.length) },
          { key: "keywords", label: "关键词", value: String(snapshot.keywords.length) },
          { key: "uncovered", label: "未映射核心关键词", value: String(uncovered.length), tone: uncovered.length ? "warn" : "ok" },
        ],
        uncovered_core_keywords: uncovered,
      };
    },
    listBlog: async (id, query) => {
      const snapshot = await load(resolve(id));
      const rows = snapshot.blogIndex.filter((row) => {
        if (query.filters?.issue === "no_links") return row.links_internal.length === 0;
        if (query.filters?.issue === "links_oos") return (row.linked_out_of_stock?.length ?? 0) > 0;
        if (query.filters?.issue === "no_schema") {
          const page = snapshot.seoPages.find((candidate) => candidate.url === row.url);
          return !page?.schema_types?.some((type) => /article|blogposting/i.test(type));
        }
        return true;
      });
      return paginate(rows, query, (row) => [row.url, row.title, row.slug, row.author, row.category, row.tags], "published_at", (row) => row.url);
    },
    listKeywords: async (id, query) => {
      const snapshot = await load(resolve(id));
      const rows = snapshot.keywords.filter((row) => (!query.filters?.role || row.role === query.filters.role)
        && (!query.filters?.status || row.status === query.filters.status));
      return paginate(rows, query, (row) => [row.keyword, row.target_url, row.cluster, row.intent, row.note], "keyword", (row) => row.keyword);
    },
    listDrafts: async (id): Promise<DraftRow[]> => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const folder = snapshot.config.workspace_folders.find((row) => row.name === "内容");
      if (!folder) return [];
      const root = path.join(projectPath, folder.name);
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const drafts: DraftRow[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const draftPath = path.join(root, entry.name);
        const children = await readdir(draftPath, { withFileTypes: true }).catch(() => []);
        const files = children.filter((child) => child.isFile()).map((child) => child.name).sort(codeUnitCompare);
        const dateMatch = /^(\d{4}-\d{2}-\d{2})[-_ ]?(.+)?$/.exec(entry.name);
        const modified = await stat(draftPath).catch(() => null);
        const date = dateMatch?.[1] ?? modified?.mtime.toISOString().slice(0, 10) ?? snapshot.asOf;
        const slug = dateMatch?.[2] || entry.name;
        const status: DraftRow["status"] = files.some((name) => /published/i.test(name)) ? "published"
          : files.some((name) => /draft/i.test(name)) ? "draft" : "brief";
        drafts.push({ date, slug, folder: folder.name, files: files.map((name) => `${folder.name}/${entry.name}/${name}`), status });
      }
      return drafts.sort((a, b) => codeUnitCompare(b.date, a.date) || codeUnitCompare(a.slug, b.slug));
    },
  };

  const edm: CoreService["edm"] = {
    summary: async (id) => {
      const snapshot = await load(resolve(id));
      const result = { total: snapshot.products.length, feed: 0, manual: 0, none: 0 };
      for (const product of snapshot.products) result[product.image_source] += 1;
      return result;
    },
    listImages: async (id, query) => {
      const snapshot = await load(resolve(id));
      const manual = new Map(snapshot.skuMedia.filter((row) => row.image_role === "main")
        .map((row) => [String(row.sku ?? ""), typeof row.image_url === "string" ? row.image_url : null]));
      const rows: SkuImageRow[] = snapshot.skus.filter((sku) => sku.status === "active").map((sku) => {
        const manualImage = manual.get(sku.sku) ?? null;
        const feedImage = sku.image_url ?? null;
        const priority: readonly ("feed" | "manual")[] = snapshot.config.edm?.image_priority ?? ["feed", "manual"];
        const used: SkuImageRow["used"] = priority.find((source) => source === "feed" ? !!feedImage : !!manualImage) ?? "none";
        return {
          sku: sku.sku,
          title: sku.title,
          variant_title: sku.variant_title,
          stock_status: snapshot.latest.find((row) => row.sku === sku.sku)?.stock_status ?? "unknown",
          feed_image_url: feedImage,
          manual_image_url: manualImage,
          used,
        };
      }).filter((row) => {
        if (query.filters?.view === "in_stock") return row.stock_status === "in_stock";
        if (query.filters?.view === "no_feed") return row.feed_image_url === null;
        if (query.filters?.view === "has_manual") return row.manual_image_url !== null;
        if (query.filters?.view === "none") return row.feed_image_url === null && row.manual_image_url === null;
        return true;
      });
      return paginate(rows, query, (row) => [row.sku, row.title, row.variant_title], "sku", (row) => row.sku);
    },
    setManualImage: async (id, sku, imageUrl) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const record = snapshot.skus.find((row) => row.sku === sku);
      if (!record) throw siteError("UNKNOWN", "找不到指定 SKU。", sku);
      let normalizedUrl: string | null = null;
      if (imageUrl !== null) {
        try {
          const parsed = new URL(imageUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
          normalizedUrl = parsed.href;
        } catch { throw siteError("UNKNOWN", "图片地址必须是有效的 HTTP 或 HTTPS URL。", imageUrl); }
      }
      const updatedAt = localDate(snapshot.config.timezone);
      const rows = snapshot.skuMedia.filter((row) => !(row.sku === sku && row.image_role === "main"));
      if (normalizedUrl) rows.push({
        sku, image_role: "main", image_url: normalizedUrl, alt_text: null,
        source: /mailchimp|mcusercontent\.com/i.test(normalizedUrl) ? "mailchimp" : "cdn",
        width: null, height: null, updated_at: updatedAt,
      });
      await writeCsv(path.join(projectPath, PATHS.skuMedia), rows, CSV_HEADERS.skuMedia, ["sku", "image_role"]);
      await buildViews(projectPath, { date: snapshot.asOf });
      invalidate(projectPath);
      const after = await load(projectPath);
      const manualImage = normalizedUrl;
      const feedImage = record.image_url ?? null;
      const priority = after.config.edm?.image_priority ?? ["feed", "manual"];
      const used = priority.find((source) => source === "feed" ? !!feedImage : !!manualImage) ?? "none";
      return {
        sku, title: record.title, variant_title: record.variant_title,
        stock_status: after.latest.find((row) => row.sku === sku)?.stock_status ?? "unknown",
        feed_image_url: feedImage, manual_image_url: manualImage, used,
      };
    },
    buildCommand: async (id, input: EdmCommandInput) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const folder = snapshot.config.workspace_folders.find((row) => row.name === "edm")?.name ?? "edm";
      const slug = categorySlug(input.theme);
      const campaignPath = path.join(projectPath, folder, `${localDate(snapshot.config.timezone)}-${slug}`);
      const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
      const command = `siteindex edm render ${quote(id)} ${quote(campaignPath)}`;
      return input.promo_code ? `${command} --promo-code ${quote(input.promo_code)}` : command;
    },
  };

  const design: CoreService["design"] = {
    get: async (id) => {
      const projectPath = resolve(id);
      const tokens = await readJsonAs<DesignTokens | null>(projectPath, PATHS.designTokens, null);
      const names = await readdir(path.join(projectPath, PATHS.designScreenshots)).catch(() => []);
      return { tokens, screenshots: names.sort(codeUnitCompare).map((name) => ({ name, path: path.join(projectPath, PATHS.designScreenshots, name) })) };
    },
  };

  const readme: CoreService["readme"] = {
    get: async (id): Promise<ReadmeData> => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const markdown = await readFile(path.join(projectPath, PATHS.readme), "utf8").catch(() => "");
      const updatedAt = await stat(path.join(projectPath, PATHS.readme)).then((value) => value.mtime.toISOString()).catch(() => null);
      const auto_blocks = [...markdown.matchAll(/<!-- siteindex:auto:start id="([^"]+)" -->([\s\S]*?)<!-- siteindex:auto:end id="\1" -->/g)]
        .map((match) => ({
          id: match[1]!,
          title: ({
            "index-summary": "数据概况", "folder-map": "工作区目录", "task-routing": "任务路由",
            "data-guide": "数据指南", "design-summary": "设计摘要", changelog: "最近变更",
          } as Record<string, string>)[match[1]!] ?? match[1]!,
          updated_at: updatedAt,
          schedule: Object.entries(snapshot.config.schedule)
            .filter(([, value]) => "enabled" in value && value.enabled)
            .map(([job, value]) => `${job} ${(value as { time: string }).time}`)
            .join("、"),
        }));
      return { user_blocks: readmeUserBlocks(markdown), auto_blocks, folder_map: await listProjectFolders(projectPath, snapshot.config) };
    },
    saveUserBlocks: async (id, blocks) => {
      const projectPath = resolve(id);
      let markdown = await readFile(path.join(projectPath, PATHS.readme), "utf8").catch(() => "# 项目说明\n");
      markdown = replaceReadmeSection(markdown, "项目概况", blocks.overview);
      markdown = replaceReadmeSection(markdown, "当前重点", blocks.focus);
      markdown = replaceReadmeSection(markdown, "工作规则与偏好", blocks.rules);
      try { await atomicWrite(path.join(projectPath, PATHS.readme), markdown); }
      catch (error) { throw setError(error); }
      invalidate(projectPath);
    },
    refresh: async (id) => {
      const projectPath = resolve(id);
      const result = await runJob({ projectPath, job: "readme", trigger: "manual" }, () => undefined);
      if (result.status === "failed") throw siteError("WRITE_FAILED", result.summary, result.errors?.join("\n"));
      return { runId: result.runId };
    },
  };

  const folders: CoreService["folders"] = {
    list: async (id) => {
      const snapshot = await load(resolve(id));
      return await listProjectFolders(snapshot.projectPath, snapshot.config);
    },
    create: async (id, name, description) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const folderName = name.trim();
      if (!folderName || folderName === "." || folderName === ".." || /[\\/<>:"|?*\u0000-\u001f]/.test(folderName)) {
        throw siteError("UNKNOWN", "文件夹名称无效。", name);
      }
      if (snapshot.config.workspace_folders.some((folder) => folder.name === folderName)) {
        throw siteError("FOLDER_EXISTS", "工作区文件夹已存在。", folderName);
      }
      const folderPath = path.join(projectPath, folderName);
      try {
        await mkdir(folderPath, { recursive: false });
        await atomicWrite(path.join(folderPath, PATHS.aboutFile), `${description.trim() || "待补充说明"}\n`);
        const config: SiteConfig = { ...snapshot.config, workspace_folders: [...snapshot.config.workspace_folders, { name: folderName, default: false }] };
        await atomicWrite(path.join(projectPath, PATHS.site), `${JSON.stringify(config, null, 2)}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw siteError("FOLDER_EXISTS", "目标文件夹已存在。", folderName);
        throw setError(error);
      }
      invalidate(projectPath);
      await runJob({ projectPath, job: "readme", trigger: "manual" }, () => undefined);
      return await listProjectFolders(projectPath, (await load(projectPath)).config);
    },
    describe: async (id, name, description) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      if (!snapshot.config.workspace_folders.some((folder) => folder.name === name)) throw siteError("PROJECT_NOT_FOUND", "找不到工作区文件夹。", name);
      const folderPath = path.join(projectPath, name);
      try {
        const current = await readFile(path.join(folderPath, PATHS.aboutFile), "utf8").catch(() => "");
        await mkdir(folderPath, { recursive: true });
        await atomicWrite(path.join(folderPath, PATHS.aboutFile), setFirstParagraph(current, description));
      } catch (error) { throw setError(error); }
      invalidate(projectPath);
      await runJob({ projectPath, job: "readme", trigger: "manual" }, () => undefined);
      return await listProjectFolders(projectPath, (await load(projectPath)).config);
    },
  };

  const categories: CoreService["categories"] = {
    get: async (id) => (await load(resolve(id))).config.categories,
    preview: async (id, config) => categoryPreview(await load(resolve(id)), config),
    save: async (id, config) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const preview = categoryPreview(snapshot, config);
      const nextConfig: SiteConfig = { ...snapshot.config, categories: config };
      const skus = applyCategoryConfig(snapshot.skus, config);
      try {
        await atomicWrite(path.join(projectPath, PATHS.site), `${JSON.stringify(nextConfig, null, 2)}\n`);
        await writeJsonl(path.join(projectPath, PATHS.skus), skus as unknown as JsonRecord[], "sku");
        const latest = new Map(snapshot.latest.map((row) => [row.sku, row.stock_status]));
        const categoryRows: Category[] = preview.categories.map((category) => {
          const members = skus.filter((sku) => sku.status === "active" && sku.category === category.slug);
          return {
            slug: category.slug,
            name: category.name,
            url: category.url,
            parent: null,
            source: config.mode,
            product_count: new Set(members.map((sku) => sku.handle)).size,
            sku_count: members.length,
            in_stock_count: members.filter((sku) => latest.get(sku.sku) === "in_stock").length,
            intro_text_words: null,
            last_seen: snapshot.asOf,
          };
        });
        await atomicWrite(path.join(projectPath, PATHS.categories), `${JSON.stringify(categoryRows, null, 2)}\n`);
        await buildViews(projectPath, { date: snapshot.asOf });
      } catch (error) { throw setError(error); }
      invalidate(projectPath);
      return preview;
    },
  };

  const schedule: CoreService["schedule"] = {
    get: async (id): Promise<ScheduleState> => {
      const config = (await load(resolve(id))).config.schedule;
      const next_runs = (["daily", "validate", "weekly", "readme", "monthly"] as const).map((job) => ({ job, at: null }));
      return { config, registered: false, next_runs };
    },
    save: async (id, config) => {
      const projectPath = resolve(id);
      const snapshot = await load(projectPath);
      const next: SiteConfig = { ...snapshot.config, schedule: config };
      try { await atomicWrite(path.join(projectPath, PATHS.site), `${JSON.stringify(next, null, 2)}\n`); }
      catch (error) { throw setError(error); }
      invalidate(projectPath);
      return { config, registered: false, next_runs: (["daily", "validate", "weekly", "readme", "monthly"] as const).map((job) => ({ job, at: null })) };
    },
  };

  const runner: CoreService["runner"] = {
    get: async (id): Promise<RunnerState> => {
      const projectPath = resolve(id);
      const runnerInfo = await readRunner(projectPath);
      const thisDevice = { device_id: ctx.deviceId, device_name: ctx.deviceName ?? "SiteIndex" };
      return { runner: runnerInfo, this_device: thisDevice, is_this_device: runnerInfo?.device_id === thisDevice.device_id };
    },
  };

  const fileSpecs: { relative: string; kind: FileCheck["kind"]; format: "json" | "jsonl" | "csv" | "text"; repair?: RepairAction }[] = [
    { relative: PATHS.readme, kind: "doc", format: "text", repair: "regenerate:readme" },
    { relative: PATHS.agentsMd, kind: "doc", format: "text" },
    { relative: PATHS.claudeMd, kind: "doc", format: "text" },
    { relative: PATHS.site, kind: "config", format: "json" },
    { relative: PATHS.skus, kind: "sync", format: "jsonl", repair: "regenerate:daily" },
    { relative: PATHS.productDetails, kind: "sync", format: "jsonl", repair: "regenerate:weekly.product_details" },
    { relative: PATHS.categories, kind: "sync", format: "json", repair: "regenerate:weekly.categories" },
    { relative: PATHS.inventoryLatest, kind: "sync", format: "jsonl", repair: "regenerate:daily" },
    { relative: PATHS.dailySummary, kind: "sync", format: "csv", repair: "regenerate:daily" },
    { relative: PATHS.seoPages, kind: "sync", format: "jsonl", repair: "regenerate:weekly.pages" },
    { relative: PATHS.seoIssues, kind: "sync", format: "jsonl", repair: "regenerate:weekly.issues" },
    { relative: PATHS.seoLinks, kind: "sync", format: "jsonl", repair: "regenerate:weekly.links" },
    { relative: PATHS.blogIndex, kind: "sync", format: "jsonl", repair: "regenerate:weekly.blog" },
    { relative: PATHS.keywords, kind: "ledger", format: "jsonl" },
    { relative: PATHS.skuMedia, kind: "ledger", format: "csv" },
    { relative: PATHS.skuTags, kind: "ledger", format: "csv" },
    { relative: PATHS.edmCampaigns, kind: "ledger", format: "jsonl" },
    { relative: PATHS.outreach, kind: "ledger", format: "jsonl" },
    { relative: PATHS.productsView, kind: "view", format: "jsonl", repair: "regenerate:views" },
    { relative: PATHS.skuStockView, kind: "view", format: "jsonl", repair: "regenerate:views" },
    { relative: PATHS.runs, kind: "sync", format: "jsonl" },
  ];

  const validateProject = async (id: ProjectId, selectedPath?: string): Promise<ValidationReport> => {
    const projectPath = resolve(id);
    const snapshot = await load(projectPath);
    let selected = "";
    if (selectedPath) {
      selected = selectedPath.replaceAll("\\", "/").replace(/^\.\//, "");
      const absolute = path.resolve(projectPath, selected);
      const relative = path.relative(projectPath, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw siteError("PATH_OUTSIDE_PROJECT", "校验路径必须位于项目目录内。", selectedPath);
      selected = relative.replaceAll("\\", "/");
    }
    const specs = fileSpecs.filter((spec) => !selected || spec.relative === selected || spec.relative.startsWith(`${selected}/`));
    const checks: FileCheck[] = [];
    for (const spec of specs) {
      const filePath = path.join(projectPath, spec.relative);
      try {
        const info = await stat(filePath);
        let records: number | null = null;
        try {
          if (spec.format === "json") {
            const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
            records = Array.isArray(value) ? value.length : 1;
          } else if (spec.format === "jsonl") records = (await readJsonl(filePath)).length;
          else if (spec.format === "csv") {
            const rows = await readCsv(filePath);
            records = rows.length;
            const expected = spec.relative === PATHS.dailySummary ? CSV_HEADERS.dailySummary
              : spec.relative === PATHS.skuMedia ? CSV_HEADERS.skuMedia
                : spec.relative === PATHS.skuTags ? CSV_HEADERS.skuTags : null;
            if (expected) {
              const header = (await readFile(filePath, "utf8")).split(/\r?\n/, 1)[0] ?? "";
              if (header !== expected.join(",")) throw Object.assign(new Error(`CSV 表头应为 ${expected.join(",")}`), { rule: "header" });
            }
          } else {
            records = 1;
            await readFile(filePath, "utf8");
          }
          const copies = await findConflictCopies(path.dirname(filePath));
          const targetCopy = copies.find((copy) => path.basename(copy).toLowerCase().startsWith(path.basename(filePath).toLowerCase()));
          checks.push({
            path: spec.relative, kind: spec.kind, status: targetCopy ? "conflict_copy" : "ok",
            ...(targetCopy ? { rule: "conflict_copy", message: `发现冲突副本：${path.basename(targetCopy)}` } : {}),
            records, size: info.size, modified_at: info.mtime.toISOString(), repair: targetCopy ? "delete_copy" : spec.repair ?? null,
          });
        } catch (error) {
          const rule = typeof error === "object" && error !== null && "rule" in error && error.rule === "header" ? "header" : "parse";
          checks.push({ path: spec.relative, kind: spec.kind, status: "error", rule, message: error instanceof Error ? error.message : String(error), records: null, size: info.size, modified_at: info.mtime.toISOString(), repair: spec.repair ?? "autofix" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          checks.push({ path: spec.relative, kind: spec.kind, status: "error", rule: "parse", message: error instanceof Error ? error.message : String(error), repair: spec.repair ?? null });
        } else checks.push({ path: spec.relative, kind: spec.kind, status: "missing", rule: "missing", message: "文件不存在。", repair: spec.repair ?? null });
      }
    }
    const report: ValidationReport = {
      checked_at: zonedTimestamp(snapshot.config.timezone),
      trigger: "manual",
      summary: {
        total: checks.length,
        ok: checks.filter((check) => check.status === "ok").length,
        error: checks.filter((check) => check.status === "error").length,
        missing: checks.filter((check) => check.status === "missing").length,
        conflict_copy: checks.filter((check) => check.status === "conflict_copy").length,
      },
      files: checks,
    };
    try { await atomicWrite(path.join(projectPath, PATHS.validation), `${JSON.stringify(report, null, 2)}\n`); }
    catch (error) { throw setError(error); }
    return report;
  };

  const files: CoreService["files"] = {
    lastReport: async (id) => await readJsonAs<ValidationReport | null>(resolve(id), PATHS.validation, null),
    validate: validateProject,
    repair: async (id, relativePath, action) => {
      const projectPath = resolve(id);
      const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      const absolute = path.resolve(projectPath, normalized);
      const inside = path.relative(projectPath, absolute);
      if (inside.startsWith("..") || path.isAbsolute(inside)) throw siteError("PATH_OUTSIDE_PROJECT", "修复路径必须位于项目目录内。", relativePath);
      if (action === "delete_copy") {
        if (!isConflictCopy(path.basename(absolute))) throw siteError("UNKNOWN", "指定文件不是已识别的冲突副本。", relativePath);
        await unlink(absolute).catch((error: unknown) => { throw setError(error); });
      } else if (action === "autofix") {
        const schemaByPath: Record<string, string | { primaryKey: string[]; fieldOrder: string[] }> = {
          [PATHS.skus]: "sku", [PATHS.inventoryLatest]: "inventory_latest", [PATHS.seoPages]: "page",
          [PATHS.seoIssues]: { primaryKey: ["url", "rule"], fieldOrder: ["url", "rule", "severity", "detail", "status", "first_seen", "last_seen"] },
          [PATHS.seoLinks]: { primaryKey: ["from", "to", "anchor"], fieldOrder: ["from", "to", "anchor", "to_type", "nofollow"] },
          [PATHS.blogIndex]: "blog_post", [PATHS.keywords]: "keyword", [PATHS.edmCampaigns]: "edm_campaign",
          [PATHS.outreach]: "outreach_contact",
        };
        const schema = schemaByPath[normalized];
        if (schema) await writeJsonl(absolute, await readJsonl(absolute), schema);
        else if (normalized === PATHS.skuMedia || normalized === PATHS.skuTags || normalized === PATHS.dailySummary) {
          const headers = normalized === PATHS.skuMedia ? CSV_HEADERS.skuMedia : normalized === PATHS.skuTags ? CSV_HEADERS.skuTags : CSV_HEADERS.dailySummary;
          const key = normalized === PATHS.skuMedia ? ["sku", "image_role"] : normalized === PATHS.dailySummary ? ["date", "category"] : ["sku"];
          await writeCsv(absolute, await readCsv(absolute), headers, key);
        } else throw siteError("UNKNOWN", "此文件暂不支持自动整理。", normalized);
      } else if (action.startsWith("regenerate:")) {
        const task = action.slice("regenerate:".length).split(".", 1)[0] ?? "";
        if (!(JOB_NAMES as readonly string[]).includes(task)) throw siteError("UNKNOWN", "不支持此文件的重新生成操作。", action);
        const result = await runJob({ projectPath, job: task as JobRequest["job"], trigger: "manual" }, () => undefined);
        if (result.status === "failed") throw siteError("WRITE_FAILED", result.summary, result.errors?.join("\n"));
      } else {
        throw siteError("UNKNOWN", "此修复操作尚未实现。", action);
      }
      invalidate(projectPath);
      const report = await validateProject(id, normalized);
      return report.files.find((check) => check.path === normalized) ?? {
        path: normalized, kind: "sync", status: "ok", message: "修复已完成。",
      };
    },
  };

  return { projects, overview, inventory, products, seo, content, edm, design, readme, categories, folders, files, schedule, runner, runJob, invalidate };
}
