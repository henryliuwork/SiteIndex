import { googleSiteSearchUrl } from "@siteindex/shared";
import type {
  AppSettings, BlogPost, BrowserStatus, CategoriesConfig, Category, CategoryPreview, CliStatus,
  DesignTokens, DraftRow, EdmCommandInput, FileCheck, FolderRow, InventorySummary, JobName,
  JobProgress, JobResult, Keyword, ListQuery, OverviewData, PageResult, ProductFilters,
  ProductFull, ProductView, ProjectDetail, ProjectId, ProjectSummary, RepairAction, RunLog,
  RunnerInfo, RunnerState, ScheduleConfig, ScheduleState, SeoIssue, SeoLink, SeoPage,
  SeoPageFilters, SiteConfig, SiteIndexApi, SkuImageFilters, SkuImageRow, SkuRecord,
  SkuStockFilters, SkuStockView, StockStatus, ValidationReport,
} from "@siteindex/shared";
import rawFixtures from "./data.json";

interface MockFixtures {
  generatedSkuCount: number;
  projects: { id: ProjectId; name: string; domain: string; source: string }[];
  site: Partial<SiteConfig>;
  skus: SkuRecord[];
  products: ProductView[];
  stock: { sku: string; stock_status: StockStatus; qty: number | null; since: string; checked_at: string }[];
  categories: (Partial<Category> & Pick<Category, "slug" | "name" | "url" | "last_seen">)[];
  events: { date: string; sku: string; type: string; from: unknown; to: unknown; category: string; title: string }[];
  pages: { url: string; type: string; title: string | null; meta_description: string | null; h1: string | null; canonical: string | null; status_code: number; indexable: boolean; word_count: number | null; last_crawled: string }[];
  blogs: BlogPost[];
  keywords: Keyword[];
  runs: RunLog[];
  dailyReports: { date: string; markdown: string }[];
}

const fixtures = rawFixtures as unknown as MockFixtures;
type MockProjectId = "kingsyard" | "riverstone";
const projectKey = (id: ProjectId): MockProjectId => id === "riverstone" ? "riverstone" : "kingsyard";
const FIXED_TODAY = "2026-10-22";
const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const errorMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "error";
const dateBefore = (days: number): string => {
  const date = new Date(FIXED_TODAY + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
const delay = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 201)));
  if (errorMode) throw new Error("模拟接口错误：请移除地址中的 ?mock=error 后重试。");
};
const reply = async <T,>(value: T | (() => T)): Promise<T> => {
  await delay();
  return clone(typeof value === "function" ? (value as () => T)() : value);
};

const statusChars: Record<StockStatus, string> = { in_stock: "i", out_of_stock: "o", preorder: "p", unknown: "u" };
const statusNames: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const generatedStatus = (index: number): StockStatus => {
  const value = (index * 37 + 11) % 100;
  if (value < 70) return "in_stock";
  if (value < 88) return "out_of_stock";
  if (value < 96) return "preorder";
  return "unknown";
};

function makeHistory(index: number, current: StockStatus): string {
  const currentChar = statusChars[current];
  const previousChar = currentChar === "i" ? "o" : "i";
  if (index === 2) return "i".repeat(29) + "o";
  if (index === 4) return "i".repeat(17) + "o".repeat(9) + "i".repeat(4);
  if (index === 6) return "i".repeat(21) + "o".repeat(9);
  if (index === 7) return "i".repeat(12) + "o".repeat(18);
  if (index === 9) return "i".repeat(21) + "p".repeat(9);
  if (index === 11) return "i".repeat(29) + "u";
  if (index === 0 || index === 17) return previousChar.repeat(5) + currentChar.repeat(5) + previousChar.repeat(5) + currentChar.repeat(15);
  if (index % 11 === 0) return previousChar.repeat(26) + currentChar.repeat(4);
  return currentChar.repeat(30);
}

function rowFromSku(record: SkuRecord, history: string, since: string): SkuStockView {
  const states = history.split("");
  const online = states.filter((state) => state === "i").length;
  const online7 = states.slice(-7).filter((state) => state === "i").length;
  let changes = 0;
  for (let i = 1; i < states.length; i += 1) if (states[i] !== states[i - 1]) changes += 1;
  const age = Math.floor((Date.parse(FIXED_TODAY) - Date.parse(since)) / 86_400_000);
  const daysInStatus = Math.max(1, Number.isFinite(age) ? age : 1);
  const previous = states[states.length - 2] as string;
  const current = states[states.length - 1] as string;
  const reverseNames: Record<string, string> = { i: "有货", o: "缺货", p: "预售", u: "未知", "-": "未上架" };
  const stockStatus = (Object.keys(statusChars) as StockStatus[]).find((status) => statusChars[status] === current) ?? "unknown";
  return {
    sku: record.sku, title: record.title, variant_title: record.variant_title, category: record.category,
    price: record.price, stock_status: stockStatus, since, days_in_status: daysInStatus,
    online_rate_7d: online7 / 7, online_rate_30d: online / 30, history_30d: history, changes_30d: changes,
    last_change: previous === current ? null : reverseNames[previous] + " → " + reverseNames[current],
    last_change_at: previous === current ? null : dateBefore((record.sku.length + changes) % 10),
  };
}

const categorySeeds: Category[] = fixtures.categories.map((category) => ({
  slug: category.slug, name: category.name, url: category.url, parent: category.parent ?? null,
  source: "feed", product_count: category.product_count ?? 0, sku_count: 0, in_stock_count: 0, last_seen: category.last_seen,
}));
const stockSeeds = new Map(fixtures.stock.map((row) => [row.sku, row]));
const recordsByProject: Record<MockProjectId, SkuRecord[]> = { kingsyard: [], riverstone: [] };
const rowsByProject: Record<MockProjectId, SkuStockView[]> = { kingsyard: [], riverstone: [] };
const todaySkus: Record<MockProjectId, Set<string>> = { kingsyard: new Set(), riverstone: new Set() };
const split = Math.ceil(fixtures.generatedSkuCount / 2);
const categoryNames: Category[] = categorySeeds.length > 0
  ? categorySeeds
  : [{ slug: "general", name: "General", url: "", parent: null, source: "feed", last_seen: FIXED_TODAY }];

for (let index = 0; index < fixtures.generatedSkuCount; index += 1) {
  const projectId: MockProjectId = index < split ? "kingsyard" : "riverstone";
  const localIndex = index < split ? index : index - split;
  const seed = fixtures.skus[localIndex % fixtures.skus.length] as SkuRecord;
  const realFixture = projectId === "kingsyard" && localIndex < fixtures.skus.length;
  const seedStock = realFixture ? stockSeeds.get(seed.sku) : undefined;
  const category = categoryNames[localIndex % categoryNames.length] as Category;
  const status = seedStock?.stock_status ?? generatedStatus(index);
  const title = realFixture ? seed.title : (projectId === "kingsyard" ? "Kingsyard " : "Riverstone Outdoor ") + category.name + " " + String(localIndex + 1);
  const handle = realFixture ? seed.handle : (projectId === "kingsyard" ? "kingsyard-item-" : "riverstone-item-") + String(localIndex + 1);
  const sku = realFixture ? seed.sku : (projectId === "kingsyard" ? "KYBF-MOCK-" : "RS-MOCK-") + String(localIndex + 1).padStart(5, "0");
  const record: SkuRecord = {
    ...seed, sku,
    product_id: realFixture ? seed.product_id : projectId.toUpperCase() + "-P" + String(Math.floor(localIndex / 2) + 1),
    handle, title, variant_title: realFixture ? seed.variant_title : (localIndex % 2 === 0 ? "Standard" : "Large"),
    url: realFixture ? seed.url : "https://" + (projectId === "kingsyard" ? "kingsyard.com" : "riverstoneoutdoor.com") + "/products/" + handle,
    category: category.slug, categories: [category.slug], category_source: "feed",
    price: realFixture ? seed.price : Math.round((seed.price * (0.72 + (localIndex % 35) / 100)) * 100) / 100,
    currency: "USD", status: "active",
    first_seen: realFixture ? seed.first_seen : dateBefore(30 + (localIndex % 300)),
    last_seen: FIXED_TODAY, updated_at: FIXED_TODAY,
  };
  recordsByProject[projectId].push(record);
  const stockHistory = realFixture && seed.sku === "KYBF007" ? "i".repeat(12) + "o".repeat(18) : makeHistory(index, status);
  const stockView = rowFromSku(record, stockHistory, seedStock?.since ?? dateBefore((index % 75) + 1));
  if (realFixture && seed.sku === "KYBF007") { stockView.since = dateBefore(18); stockView.days_in_status = 18; }
  rowsByProject[projectId].push(stockView);
  if (localIndex % 19 === 0 || localIndex % 31 === 0) todaySkus[projectId].add(sku);
}

const productsByProject: Record<MockProjectId, ProductView[]> = {
  kingsyard: fixtures.products.map((row) => clone(row)),
  riverstone: fixtures.products.map((row) => ({
    ...clone(row), handle: "riverstone-" + row.handle, product_id: "RS-" + row.product_id,
    title: "Riverstone Outdoor " + row.title.replace(/^Kingsyard\s*/i, ""),
    url: "https://riverstoneoutdoor.com/products/riverstone-" + row.handle, currency: "USD", tags: [],
  })),
};

function defaultSchedule(): ScheduleConfig {
  const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
  return {
    daily: { enabled: true, days: [...weekdays], time: "02:00" },
    validate: { enabled: true, days: [...weekdays], time: "02:30" },
    weekly: { enabled: true, days: [1], time: "03:00" },
    readme: { enabled: true, days: [7], time: "05:00" },
    monthly: { enabled: false, day_of_month: 1, time: "04:00" },
    options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: true },
  };
}

function defaultConfig(id: ProjectId): SiteConfig {
  const kingsyard = id === "kingsyard";
  const domain = kingsyard ? "kingsyard.com" : "riverstoneoutdoor.com";
  return {
    schema_version: "1.1", domain, base_url: "https://" + domain,
    platform: kingsyard ? "magento" : "shopify", currency: "USD", locale: "en-US", timezone: "America/Los_Angeles",
    markets: ["US"],
    brand: {
      name: kingsyard ? "Kingsyard" : "Riverstone Outdoor",
      tagline: kingsyard ? "Wild bird feeding supplies for backyard birders." : "Reliable gear for outdoor living.",
      voice: "Warm, practical and concise",
      audience: kingsyard ? "Backyard bird lovers and gift buyers" : "Garden and outdoor enthusiasts",
      usp: kingsyard ? ["Squirrel-resistant designs", "Easy to clean"] : ["Weather-ready materials", "Simple setup"],
    },
    sitemaps: ["https://" + domain + "/sitemap.xml"],
    crawl: { adapter: "gmc_feed", feed_url: kingsyard ? "https://" + domain + "/feed.xml" : "", sku_field: "id", category_depth: 2, missing_as: "out_of_stock", rate_limit_ms: 200 },
    categories: { mode: kingsyard ? "manual" : "url_rule" },
    workspace_folders: [{ name: "产品素材", default: true }, { name: "营销活动", default: true }, { name: "草稿", default: true }],
    schedule: defaultSchedule(),
  };
}

const projectConfigs: Record<MockProjectId, SiteConfig> = { kingsyard: defaultConfig("kingsyard"), riverstone: defaultConfig("riverstone") };
const projectIds: MockProjectId[] = ["kingsyard", "riverstone"];
const makeProjectSummary = (id: MockProjectId): ProjectSummary => {
  const rows = rowsByProject[id] ?? [];
  const inStock = rows.filter((row) => row.stock_status === "in_stock").length;
  const project = fixtures.projects.find((item) => item.id === id);
  const isKingsyard = id === "kingsyard";
  return {
    id, name: project?.name ?? (isKingsyard ? "Kingsyard" : "Riverstone Outdoor"),
    path: "D:/云盘/projects/" + (isKingsyard ? "Kingsyard" : "Riverstone-Outdoor"),
    domain: project?.domain ?? (isKingsyard ? "kingsyard.com" : "riverstoneoutdoor.com"),
    platform: isKingsyard ? "magento" : "shopify",
    sync: { state: isKingsyard ? "ok" : "never", at: isKingsyard ? "2026-10-22T02:04:00+08:00" : null, job: isKingsyard ? "daily" : null },
    sku_count: rows.length, product_count: Math.ceil(rows.length / 2),
    online_rate: rows.length === 0 ? null : inStock / rows.length,
    blog_count: isKingsyard ? fixtures.blogs.length : Math.max(7, fixtures.blogs.length),
    today: isKingsyard ? { restock: 1, oos: 2, price: 1, new: 1, removed: 0 } : { restock: 0, oos: 0, price: 0, new: 0, removed: 0 },
    attention: isKingsyard ? 0 : 1, warnings: isKingsyard ? [] : ["尚未填写 GMC feed 地址，每日库存同步未启用。"],
    runner_device: isKingsyard ? "Henry-PC" : null, is_runner: isKingsyard,
  };
};
const projectSummaries: Record<MockProjectId, ProjectSummary> = { kingsyard: makeProjectSummary("kingsyard"), riverstone: makeProjectSummary("riverstone") };
const projectsChanged = new Set<(id: ProjectId) => void>();
const notifyProjectChanged = (id: ProjectId): void => projectsChanged.forEach((callback) => callback(id));

const settingsState: AppSettings = {
  device_id: "mock-device", device_name: "Henry-PC", projects_root: "D:/云盘/projects",
  extra_projects: [], cache_dir: "C:/SiteIndex/Cache", browser: { channel: "msedge", executable_path: null },
  notify: { on_failure: true, on_success: false, oos_threshold: 0.12, dingtalk_webhook: null },
  skill_platforms: [
    { id: "claude-code", name: "Claude Code", dir: "~/.claude/skills", detected: false },
    { id: "codex", name: "Codex", dir: "~/.codex/skills", detected: true },
  ],
  conflict_patterns: ["*.conflict-*", "*.copy"],
};
const folderRows: Record<MockProjectId, FolderRow[]> = {
  kingsyard: [
    { name: "产品素材", description: "产品图片、Feed 素材与规格表。", default: true, files: 24, modified_at: "2026-10-21T18:00:00-07:00" },
    { name: "营销活动", description: "EDM、促销与渠道活动资料。", default: true, files: 8, modified_at: "2026-10-20T12:00:00-07:00" },
    { name: "草稿", description: "待审核的内容草稿。", default: true, files: 3, modified_at: null },
  ],
  riverstone: [
    { name: "产品素材", description: "产品图片与规格表。", default: true, files: 12, modified_at: "2026-10-21T12:00:00-07:00" },
    { name: "草稿", description: "待审核的内容草稿。", default: true, files: 2, modified_at: null },
  ],
};
const userReadmeBlocks: Record<MockProjectId, { overview: string; focus: string; rules: string }> = {
  kingsyard: { overview: "为后院观鸟者提供实用的喂鸟产品。", focus: "检查缺货 SKU，并优先补齐高流量产品。", rules: "保留品牌温暖、实用的语气。" },
  riverstone: { overview: "为庭院和户外生活提供耐用装备。", focus: "维护商品资料与季节性内容。", rules: "说明要简洁、具体。" },
};
const categoryConfigs: Record<MockProjectId, CategoriesConfig> = { kingsyard: { mode: "manual" }, riverstone: { mode: "url_rule", url_pattern: "/collections/:category" } };
const tagsByHandle = new Map<string, string[]>();
const manualImages = new Map<string, string | null>();
const tagNames = new Set<string>(["spring", "bestseller", "seasonal"]);
const runners: Record<MockProjectId, RunnerInfo | null> = {
  kingsyard: { device_id: "mock-device", device_name: "Henry-PC", claimed_at: "2026-10-20T09:00:00+08:00" },
  riverstone: null,
};
const scheduleStates: Record<MockProjectId, ScheduleState> = {
  kingsyard: { config: defaultSchedule(), registered: false, next_runs: [{ job: "daily", at: "2026-10-23T02:00:00+08:00" }] },
  riverstone: { config: defaultSchedule(), registered: false, next_runs: [{ job: "daily", at: "2026-10-23T02:00:00+08:00" }] },
};

function pageFromSeed(seed: MockFixtures["pages"][number]): SeoPage {
  const title = seed.title;
  const description = seed.meta_description;
  return {
    url: seed.url, page_type: seed.type as SeoPage["page_type"], status_code: seed.status_code,
    title, title_length: title?.length ?? 0, meta_description: description, description_length: description?.length ?? 0,
    h1: seed.h1, h1_count: seed.h1 ? 1 : 0, canonical: seed.canonical,
    canonical_status: seed.canonical === seed.url ? "self" : seed.canonical ? "other" : "missing",
    robots_meta: null, x_robots_tag: null, indexable: seed.indexable, in_sitemap: true,
    schema_types: [], word_count: seed.word_count, last_crawled: seed.last_crawled,
  };
}
const seoPages = fixtures.pages.map(pageFromSeed);
const seoIssues: SeoIssue[] = [
  { url: "https://kingsyard.com/products/feeder-12", rule: "title_length", severity: "mid", detail: "标题长度偏短", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "https://kingsyard.com/collections/bird-feeders", rule: "img_alt_missing", severity: "low", detail: "有 3 张图片缺少替代文本", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
];

function inventorySummary(id: ProjectId, days = 30): InventorySummary {
  const key = projectKey(id);
  const rows = rowsByProject[key];
  const counts = { in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 };
  const categories = new Map<string, { total: number; inStock: number }>();
  for (const row of rows) {
    counts[row.stock_status] = counts[row.stock_status] + 1;
    const group = categories.get(row.category) ?? { total: 0, inStock: 0 };
    group.total += 1;
    if (row.stock_status === "in_stock") group.inStock += 1;
    categories.set(row.category, group);
  }
  const total = rows.length;
  const categoryPriority = (name: string) => /bird-feeders/i.test(name) ? 0 : /bird-houses/i.test(name) ? 1 : /bird-baths/i.test(name) ? 2 : 3;
  const names = [...categories.keys()].sort((left, right) => categoryPriority(left) - categoryPriority(right));
  const dates = Array.from({ length: days }, (_, index) => dateBefore(days - index - 1));
  const trendNames = names.slice(0, 3).sort((left, right) => {
    const priority = (name: string) => /bird-feeders/i.test(name) ? 0 : /bird-baths/i.test(name) ? 1 : /bird-houses/i.test(name) ? 2 : 3;
    return priority(left) - priority(right);
  });
  const trendSeries = trendNames.map((name) => ({
    category: name,
    rates: dates.map((_, day) => {
      if (/bath/i.test(name)) return day < 8 ? 0.75 : day < 13 ? 0.5 : day < 19 ? 0.62 : 0.5;
      if (/house/i.test(name)) return day < 8 ? 1 : 0.98;
      const rate = 0.91 + Math.sin(day / 4) * 0.025 - (day > 25 ? (day - 25) * 0.04 : 0);
      return Math.max(0.72, Math.min(0.98, rate));
    }),
  }));
  const categoryRates = names.map((name) => {
    const group = categories.get(name) ?? { total: 0, inStock: 0 };
    const rate = /bath/i.test(name) ? 0.5 : /house/i.test(name) ? 1 : 0.73;
    return { category: name, rate, total: group.total };
  }).sort((left, right) => categoryPriority(left.category) - categoryPriority(right.category)).slice(0, 3);
  const todayRows = rows.filter((row) => todaySkus[key].has(row.sku)).slice(0, 4);
  const today = todayRows.map((row, index) => ({
    type: (["restock", "oos", "price", "new", "removed"] as const)[index % 5]!,
    sku: row.sku, title: row.title, detail: row.last_change ?? statusNames[row.stock_status],
  }));
  const averageRate = trendSeries.flatMap((series) => series.rates).filter((rate): rate is number => rate !== null).reduce((sum, rate, _, all) => sum + rate / all.length, 0);
  const sampleRows = key === "kingsyard" ? rows.slice(0, fixtures.skus.length) : rows;
  const longOut = sampleRows.filter((row) => row.stock_status === "out_of_stock" && row.days_in_status >= 14).sort((left, right) => right.days_in_status - left.days_in_status);
  const volatile = sampleRows.filter((row) => row.changes_30d >= 3).length;
  const todayCounts = projectSummaries[key].today;
  const todayHint = [
    todayCounts.restock ? "到货 " + todayCounts.restock : "",
    todayCounts.oos ? "缺货 " + todayCounts.oos : "",
    todayCounts.price ? "调价 " + todayCounts.price : "",
    todayCounts.new ? "上新 " + todayCounts.new : "",
  ].filter(Boolean).join(" · ") || "今天无库存变化";
  return {
    as_of: FIXED_TODAY,
    kpis: [
      { key: "current-rate", label: "当前在线率（SKU）", value: total ? ((counts.in_stock / total) * 100).toFixed(1) + "%" : "—", hint: counts.in_stock.toLocaleString("zh-CN") + " / " + total.toLocaleString("zh-CN") + " 有货", tone: "ok" },
      { key: "average-rate", label: "近 30 天平均在线率", value: (averageRate * 100).toFixed(1) + "%", hint: "较前 30 天 −3.2pt" },
      { key: "today-changes", label: "今日变化", value: todayCounts.restock + " −" + todayCounts.oos, hint: todayHint, tone: todayCounts.oos ? "danger" : "default" },
      { key: "long-out", label: "长期缺货（≥ 14 天）", value: longOut.length.toLocaleString("zh-CN"), hint: longOut[0] ? longOut[0].sku + " · " + longOut[0].days_in_status + " 天" : "暂无长期缺货" , tone: longOut.length ? "warn" : "default" },
      { key: "volatility", label: "状态波动（30 天 ≥ 3 次）", value: volatile.toLocaleString("zh-CN"), hint: "供货不稳定的 SKU" },
    ],
    trend: { dates, series: trendSeries }, category_rates: categoryRates,
    category_source: categoryConfigs[key].mode,
    uncategorized: rows.filter((row) => !row.category).length, today,
  };
}

function selectRows<T, F = Record<string, unknown>>(
  source: readonly T[], query: ListQuery<F>, searchText: (row: T) => string,
  matches: (row: T, filters: F) => boolean = () => true,
): PageResult<T> {
  let rows = source.filter((row) => {
    const search = query.search?.trim().toLocaleLowerCase();
    return (!search || searchText(row).toLocaleLowerCase().includes(search)) && matches(row, (query.filters ?? {}) as F);
  });
  if (query.sort) {
    const field = query.sort.field;
    const factor = query.sort.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((left, right) => {
      const a = (left as unknown as Record<string, unknown>)[field];
      const b = (right as unknown as Record<string, unknown>)[field];
      const numericA = typeof a === "number" ? a : Number.NaN;
      const numericB = typeof b === "number" ? b : Number.NaN;
      if (!Number.isNaN(numericA) && !Number.isNaN(numericB)) return (numericA - numericB) * factor;
      return String(a ?? "").localeCompare(String(b ?? ""), "zh-CN") * factor;
    });
  }
  const total = rows.length;
  if (query.pageSize === 0) return { rows, total };
  const pageSize = Math.max(1, query.pageSize || 20);
  const start = Math.max(0, query.page - 1) * pageSize;
  rows = rows.slice(start, start + pageSize);
  return { rows, total };
}

function productRows(id: ProjectId): ProductView[] {
  return productsByProject[projectKey(id)].map((row) => ({ ...row, tags: tagsByHandle.get(id + ":" + row.handle) ?? row.tags }));
}
const progressListeners = new Set<(progress: JobProgress) => void>();
const finishedListeners = new Set<(result: JobResult) => void>();
const activeRuns = new Map<string, { projectPath: string; job: JobName; timer: ReturnType<typeof setInterval>; pct: number }>();
let runCounter = 0;
const runHistory: RunLog[] = [
  { run_id: "mock-daily-today", job: "daily", trigger: "schedule", device_name: "Henry-PC", started_at: "2026-10-22T02:04:00+08:00", finished_at: "2026-10-22T02:05:16+08:00", status: "ok", counts: { restock: 1, out_of_stock: 2, price: 1, new: 1 } },
  { run_id: "mock-validate-today", job: "validate", trigger: "schedule", device_name: "Henry-PC", started_at: "2026-10-22T02:30:00+08:00", finished_at: "2026-10-22T02:30:08+08:00", status: "partial", errors: ["0 个错误 · unknown 库存 1/19（5.3%）"] },
  { run_id: "mock-daily-yesterday", job: "daily", trigger: "schedule", device_name: "Henry-PC", started_at: "2026-10-21T02:03:00+08:00", finished_at: "2026-10-21T02:04:12+08:00", status: "ok" },
  ...fixtures.runs,
];

function finishRun(runId: string, status: "ok" | "skipped" = "ok"): void {
  const active = activeRuns.get(runId);
  if (!active) return;
  clearInterval(active.timer);
  activeRuns.delete(runId);
  const result: JobResult = {
    runId, job: active.job, status, exitCode: status === "ok" ? 0 : 130,
    summary: status === "ok" ? "模拟任务已完成" : "模拟任务已停止",
  };
  runHistory.unshift({
    run_id: runId, job: active.job, trigger: "manual", device_name: "本地开发工作站",
    started_at: "2026-10-22T10:00:00+08:00", finished_at: "2026-10-22T10:00:02+08:00",
    status: status === "ok" ? "ok" : "skipped",
  });
  finishedListeners.forEach((callback) => callback(clone(result)));
}

function beginRun(projectPath: string, job: JobName): string {
  runCounter += 1;
  const runId = "mock-run-" + String(runCounter).padStart(3, "0");
  const active = { projectPath, job, pct: 0, timer: 0 as unknown as ReturnType<typeof setInterval> };
  active.timer = setInterval(() => {
    active.pct = Math.min(100, active.pct + 25);
    progressListeners.forEach((callback) => callback({
      runId, projectPath, job, pct: active.pct,
      step: active.pct === 100 ? "完成" : "处理示例数据",
      level: "info", message: active.pct === 100 ? "模拟任务已完成" : "正在处理示例数据",
      at: new Date().toISOString(),
    }));
    if (active.pct === 100) finishRun(runId);
  }, 300);
  activeRuns.set(runId, active);
  return runId;
}

export function createMockApi(): SiteIndexApi {
  const api: SiteIndexApi = {
    app: { version: () => reply("0.1.0-mock"), platform: () => reply("win32") },
    settings: {
      get: () => reply(settingsState),
      set: (patch) => reply(() => {
        Object.assign(settingsState, clone(patch));
        if (patch.browser) settingsState.browser = { ...settingsState.browser, ...patch.browser };
        if (patch.notify) settingsState.notify = { ...settingsState.notify, ...patch.notify };
        return settingsState;
      }),
      detectBrowser: () => reply<BrowserStatus>({ available: true, name: "浏览器 mock", path: null }),
      cliStatus: () => reply<CliStatus>({ installed: false, path: null }),
      installCli: () => reply<CliStatus>({ installed: true, path: "C:/Users/Developer/.codex/skills/siteindex" }),
      chooseDirectory: (defaultPath) => reply(defaultPath ?? "C:/SiteIndex/Projects"),
    },
    projects: {
      list: () => reply(() => projectIds.map((id) => projectSummaries[id])),
      get: (id) => reply<ProjectDetail>(() => ({
        summary: projectSummaries[projectKey(id)],
        config: projectConfigs[projectKey(id)],
        runner: runners[projectKey(id)],
      })),
      detect: (url) => reply(() => {
        const normalized = /^https?:\/\//i.test(url) ? url : "https://" + url;
        const baseUrl = normalized.replace(/\/$/, "");
        return {
          input: url, final_url: normalized, redirect_status: null,
          robots: { found: true, disallow_count: 0, sitemaps: [baseUrl + "/sitemap.xml"] },
          sitemaps: [{ url: baseUrl + "/sitemap.xml", type: "index", url_count: 1240 }],
          total_urls: 1240, platform: "shopify", platform_evidence: "检测到 Shopify 商品 Feed",
          frontend: "Shopify", locale: "en-US", currency: "USD", feed_candidates: [baseUrl + "/products.json"],
        };
      }),
      inspectFeed: (_feedUrls, opts) => reply(() => ({
        items: fixtures.skus.length, usable_skus: fixtures.skus.length, products: fixtures.products.length,
        skipped: { duplicate: 0, missing_price_or_link: 0, no_id: 0 },
        stock: { in_stock: fixtures.stock.filter((row) => row.stock_status === "in_stock").length, out_of_stock: 1, preorder: 0, unknown: 1 },
        field_coverage: [{ field: opts.sku_field, pct: 100 }, { field: "title", pct: 100 }, { field: "price", pct: 100 }],
        category_distribution: categorySeeds.map((category) => ({ slug: category.slug, count: category.product_count ?? 0 })),
        samples: fixtures.skus.slice(0, 5).map((row) => ({
          sku: row.sku, title: row.title, variant_title: row.variant_title, category: row.category,
          price: row.price, stock_status: stockSeeds.get(row.sku)?.stock_status ?? "in_stock",
        })),
      })),
      create: (input) => reply(() => ({ id: input.folder_name || "new-project", runId: "mock-run-create" })),
      addExisting: () => reply(projectSummaries.riverstone),
      updateConfig: (id, patch) => reply(() => {
        const key = projectKey(id);
        const current = projectConfigs[key];
        projectConfigs[key] = { ...current, ...clone(patch) };
        if (patch.domain) projectSummaries[key] = { ...projectSummaries[key], domain: patch.domain };
        notifyProjectChanged(id);
        return projectConfigs[key];
      }),
      onChanged: (callback) => { projectsChanged.add(callback); return () => projectsChanged.delete(callback); },
    },
    overview: {
      get: (id) => reply<OverviewData>(() => {
        const key = projectKey(id);
        const summary = projectSummaries[key];
        return {
          kpis: [
            { key: "sku", label: "SKU 总数", value: summary.sku_count.toLocaleString("zh-CN"), link: "/p/" + id + "/inventory" },
            { key: "products", label: "产品", value: summary.product_count.toLocaleString("zh-CN"), link: "/p/" + id + "/products" },
            { key: "online", label: "在线率", value: ((summary.online_rate ?? 0) * 100).toFixed(1) + "%", tone: "ok" },
            { key: "blogs", label: "博客文章", value: String(summary.blog_count) },
            { key: "sales", label: "30 日销量", value: "—", reserved: true },
          ],
          attention: summary.warnings.map((text) => ({ severity: "mid", text, link: "/p/" + id + "/inventory", link_label: "查看" })),
          readme: { overview: userReadmeBlocks[key].overview, focus: userReadmeBlocks[key].focus },
          agent_instruction: "进入 " + summary.path + "，先完整阅读 README.md，再根据数据开展工作。",
          changelog: [{ date: FIXED_TODAY, text: "库存数据已同步" }, { date: dateBefore(1), text: "README 已更新" }],
        };
      }),
    },
    inventory: {
      summary: (id, days = 30) => reply(() => inventorySummary(id, days)),
      listSkus: (id, query: ListQuery<SkuStockFilters>) => reply(() => selectRows(
        rowsByProject[projectKey(id)], query,
        (row) => [row.sku, row.title, row.variant_title, row.category].join(" "),
        (row, filters) => {
          const status = filters.status as SkuStockFilters["status"];
          const category = filters.category as string | undefined;
          return (!status || (status === "today" ? todaySkus[projectKey(id)].has(row.sku) : row.stock_status === status)) && (!category || row.category === category);
        },
      )),
      dailyReport: (id, date) => reply(() => fixtures.dailyReports.find((report) => report.date === date)?.markdown ?? "# " + projectSummaries[projectKey(id)].domain + " 库存日报 · " + date + "\n\n暂无该日期的日报。"),
      exportCsv: (id) => reply("mock:/exports/" + id + "-inventory.csv"),
    },
    products: {
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
        return { product, skus, details: null, seo: null };
      }),
      setTags: (id, handle, tags) => reply(() => {
        tagsByHandle.set(id + ":" + handle, [...new Set(tags)]);
        tags.forEach((tag) => tagNames.add(tag));
        return tagsByHandle.get(id + ":" + handle) ?? [];
      }),
      listTags: (id) => reply(() => [...tagNames].sort().map((tag) => ({ tag, products: productRows(id).filter((row) => row.tags.includes(tag)).length }))),
      createTag: (_id, tag) => reply(() => { tagNames.add(tag); return [...tagNames].sort().map((item) => ({ tag: item, products: 0 })); }),
      deleteTag: (_id, tag) => reply(() => { tagNames.delete(tag); return [...tagNames].sort().map((item) => ({ tag: item, products: 0 })); }),
      exportCsv: (id) => reply("mock:/exports/" + id + "-products.csv"),
    },
    seo: {
      summary: () => reply({
        kpis: [{ key: "pages", label: "已抓取页面", value: String(seoPages.length) }, { key: "issues", label: "待处理问题", value: String(seoIssues.length), tone: "warn" }],
        crawled_at: "2026-10-22T10:00:00+08:00", title_range: [30, 60] as [number, number], description_range: [120, 160] as [number, number],
      }),
      listIssues: (_id, query) => reply(() => selectRows(seoIssues, query, (row) => [row.url, row.rule, row.detail].join(" "), (row, filters) => (!filters.severity || row.severity === filters.severity) && (!filters.status || row.status === filters.status))),
      listPages: (_id, query: ListQuery<SeoPageFilters>) => reply(() => selectRows(seoPages, query, (row) => [row.url, row.title, row.meta_description].join(" "), (row, filters) => (!filters.page_type || row.page_type === filters.page_type) && (!filters.indexed || (filters.indexed === "yes" ? row.google_indexed === true : filters.indexed === "no" ? row.google_indexed === false : row.google_indexed == null)))),
      listLinks: (_id, query) => reply(() => selectRows([] as SeoLink[], query, (row) => [row.from, row.to, row.anchor].join(" "))),
      orphanPages: () => reply([] as string[]),
      getPage: (_id, url) => reply(seoPages.find((page) => page.url === url) ?? null),
      googleSiteUrl: (url) => reply(googleSiteSearchUrl(url)),
      checkIndex: async (id, _urls) => { await delay(); return { runId: beginRun("C:/SiteIndex/Projects/" + id, "index-check") }; },
    },
    content: {
      summary: () => reply({ kpis: [{ key: "blogs", label: "博客文章", value: String(fixtures.blogs.length) }, { key: "keywords", label: "关键词", value: String(fixtures.keywords.length) }], uncovered_core_keywords: ["bird feeder pole", "squirrel proof bird feeder"] }),
      listBlog: (_id, query) => reply(() => selectRows(fixtures.blogs, query, (row) => [row.title, row.slug, row.category].join(" "), (row, filters) => !filters.issue || (filters.issue === "no_links" ? row.links_internal.length === 0 && row.links_products.length === 0 : filters.issue === "no_schema" ? !row.has_faq : (row.linked_out_of_stock?.length ?? 0) > 0))),
      listKeywords: (_id, query) => reply(() => selectRows(fixtures.keywords, query, (row) => [row.keyword, row.cluster, row.target_url].join(" "), (row, filters) => (!filters.role || row.role === filters.role) && (!filters.status || row.status === filters.status))),
      listDrafts: () => reply([] as DraftRow[]),
    },
    edm: {
      summary: (id) => reply(() => {
        const rows = recordsByProject[projectKey(id)];
        const feed = rows.filter((row) => row.image_url).length;
        const manual = rows.filter((row) => manualImages.has(id + ":" + row.sku)).length;
        return { total: rows.length, feed, manual, none: rows.length - feed };
      }),
      listImages: (id, query: ListQuery<SkuImageFilters>) => reply(() => {
        const key = projectKey(id);
        const rows: SkuImageRow[] = recordsByProject[key].map((record) => {
          const manual = manualImages.get(id + ":" + record.sku) ?? null;
          const feed = record.image_url;
          return {
            sku: record.sku, title: record.title, variant_title: record.variant_title,
            stock_status: rowsByProject[key].find((row) => row.sku === record.sku)?.stock_status ?? "unknown",
            feed_image_url: feed, manual_image_url: manual, used: manual ? "manual" : feed ? "feed" : "none",
          };
        });
        return selectRows(rows, query, (row) => [row.sku, row.title].join(" "), (row, filters) => !filters.view || (filters.view === "in_stock" ? row.stock_status === "in_stock" : filters.view === "no_feed" ? row.feed_image_url == null : filters.view === "has_manual" ? row.manual_image_url != null : row.used === "none"));
      }),
      setManualImage: (id, sku, url) => reply(() => {
        manualImages.set(id + ":" + sku, url);
        const key = projectKey(id);
        const record = recordsByProject[key].find((row) => row.sku === sku);
        const stock = rowsByProject[key].find((row) => row.sku === sku);
        return {
          sku, title: record?.title ?? sku, variant_title: record?.variant_title ?? null,
          stock_status: stock?.stock_status ?? "unknown", feed_image_url: record?.image_url ?? null,
          manual_image_url: url, used: url ? "manual" : record?.image_url ? "feed" : "none",
        };
      }),
      buildCommand: (_id, input: EdmCommandInput) => reply("edm-builder --theme \"" + input.theme + "\" --count " + input.count + (input.promo_code ? " --promo-code \"" + input.promo_code + "\"" : "")),
    },
    design: { get: () => reply({ tokens: null as DesignTokens | null, screenshots: [] }) },
    readme: {
      get: (id) => reply(() => ({
        user_blocks: userReadmeBlocks[projectKey(id)],
        auto_blocks: [{ id: "inventory", title: "库存摘要", updated_at: "2026-10-22T10:00:00+08:00", schedule: "每天同步后更新" }, { id: "folders", title: "工作区文件夹", updated_at: null, schedule: "手动刷新" }],
        folder_map: folderRows[projectKey(id)],
      })),
      saveUserBlocks: (id, blocks) => reply(() => { userReadmeBlocks[projectKey(id)] = clone(blocks); }),
      refresh: async (id) => { await delay(); return { runId: beginRun("C:/SiteIndex/Projects/" + id, "readme") }; },
    },
    categories: {
      get: (id) => reply(categoryConfigs[projectKey(id)]),
      preview: (_id, config) => reply<CategoryPreview>(() => ({
        categories: categorySeeds.slice(0, 5).map((category) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: category.sku_count ?? 0 })),
        uncategorized: 12, multi_matched: 3,
        candidates: categorySeeds.slice(0, 2).map((category) => ({ url: category.url, product_links: category.product_count ?? 0, configured: config.mode === "manual" })),
      })),
      save: (id, config) => reply(() => {
        categoryConfigs[projectKey(id)] = clone(config);
        return { categories: categorySeeds.map((category) => ({ slug: category.slug, name: category.name, url: category.url, sku_count: category.sku_count ?? 0 })), uncategorized: 12, multi_matched: 3, candidates: [] };
      }),
    },
    folders: {
      list: (id) => reply(folderRows[projectKey(id)]),
      create: (id, name, description) => reply(() => {
        const key = projectKey(id);
        folderRows[key] = [...folderRows[key], { name, description, default: false, files: 0, modified_at: null }];
        return folderRows[key];
      }),
      describe: (id, name, description) => reply(() => {
        const key = projectKey(id);
        folderRows[key] = folderRows[key].map((row) => row.name === name ? { ...row, description } : row);
        return folderRows[key];
      }),
      remove: (id, name) => reply(() => {
        const key = projectKey(id);
        folderRows[key] = folderRows[key].filter((row) => row.name !== name || row.default);
        return folderRows[key];
      }),
      open: () => reply(undefined),
    },
    files: {
      lastReport: () => reply<ValidationReport | null>({
        checked_at: "2026-10-22T10:00:00+08:00", trigger: "manual",
        summary: { total: 6, ok: 5, error: 1, missing: 0, conflict_copy: 0 },
        files: [{ path: "index/catalog/skus.jsonl", kind: "sync", status: "ok", records: 5000 }, { path: "README.md", kind: "doc", status: "error", rule: "readme_markers", message: "用户区块标记缺失", repair: "autofix" }],
      }),
      validate: () => reply<ValidationReport>({
        checked_at: new Date().toISOString(), trigger: "manual",
        summary: { total: 2, ok: 1, error: 1, missing: 0, conflict_copy: 0 },
        files: [{ path: "index/catalog/skus.jsonl", kind: "sync", status: "ok", records: 5000 }, { path: "README.md", kind: "doc", status: "error", rule: "readme_markers", message: "用户区块标记缺失", repair: "autofix" }],
      }),
      repair: (_id, path, action: RepairAction) => reply<FileCheck>({ path, kind: "doc", status: "ok", rule: "readme_markers", message: "模拟修复完成：" + action, repair: action }),
    },
    jobs: {
      run: async (request) => { await delay(); return { runId: beginRun(request.projectPath, request.job) }; },
      cancel: (runId) => reply(() => finishRun(runId, "skipped")),
      history: (_id, limit = 20) => reply(() => runHistory.slice(0, limit)),
      running: () => reply(() => {
        const active = [...activeRuns.entries()][0];
        return active ? { runId: active[0], job: active[1].job } : null;
      }),
      onProgress: (callback) => { progressListeners.add(callback); return () => progressListeners.delete(callback); },
      onFinished: (callback) => { finishedListeners.add(callback); return () => finishedListeners.delete(callback); },
    },
    schedule: {
      get: (id) => reply(scheduleStates[projectKey(id)]),
      save: (id, config) => reply(() => {
        const key = projectKey(id);
        scheduleStates[key] = { ...scheduleStates[key], config: clone(config) };
        return scheduleStates[key];
      }),
    },
    runner: {
      get: (id) => reply<RunnerState>(() => ({ runner: runners[projectKey(id)], this_device: { device_id: "mock-device", device_name: "Henry-PC" }, is_this_device: projectKey(id) === "kingsyard" })),
      claim: (id) => reply<RunnerState>(() => {
        const key = projectKey(id);
        runners[key] = { device_id: "mock-device", device_name: "本地开发工作站", claimed_at: new Date().toISOString() };
        return { runner: runners[key], this_device: { device_id: "mock-device", device_name: "Henry-PC" }, is_this_device: true };
      }),
    },
    skills: {
      list: () => reply([
        { name: "site-index-onboarding", version: "1.0.0", description: "SiteIndex 项目接入指南", has_update: false, reads: ["README.md", "site.json"], writes: [] },
        { name: "site-index-maintain", version: "1.0.0", description: "SiteIndex 数据维护指南", has_update: false, reads: ["index/"], writes: ["README.md"] },
      ]),
      get: (name) => reply({ info: { name, version: "1.0.0", description: "SiteIndex 项目技能说明", has_update: false, reads: ["README.md"], writes: [] }, body: "# SiteIndex Skill\n\n请先阅读项目 README，再根据当前数据完成任务。" }),
      targets: (name) => reply([
        { target_id: "project:kingsyard", name: "Kingsyard 项目", dir: "C:/SiteIndex/Projects/Kingsyard/.agent/skills/" + name, status: "latest" },
        { target_id: "codex", name: "Codex", dir: null, status: "not_installed" },
      ]),
      install: (name, targetId) => reply({ target_id: targetId, name: name + " · " + targetId, dir: "C:/SiteIndex/mock-skills/" + name, status: "latest" }),
      syncAllProjects: () => reply(undefined),
    },
    shell: {
      openPath: () => reply(undefined),
      openExternal: () => reply(undefined),
      copyText: async (text) => {
        await delay();
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text).catch(() => undefined);
      },
    },
  };
  return api;
}
