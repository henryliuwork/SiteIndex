import { googleSiteSearchUrl, INIT_STEPS, PATHS } from "@siteindex/shared";
import type {
  AppSettings, BlogPost, BrowserStatus, CategoriesConfig, Category, CategoryPreview, CliStatus,
  DesignTokens, EdmCommandInput, FileCheck, FolderRow, InventorySummary, JobName,
  JobProgress, JobResult, Keyword, ListQuery, OverviewData, PageResult, ProductFilters,
  ProductFull, ProductView, ProjectDetail, ProjectId, ProjectSummary, ProjectUiState, RepairAction, RunLog,
  HistoryRange, RunnerInfo, RunnerState, ScheduleConfig, ScheduleState, SeoIssue, SeoLink, SeoPage, SiteIndexError, SkillInfo, SkillTargetStatus,
  SeoPageFilters, SiteConfig, SiteIndexApi, SkuImageFilters, SkuImageRow, SkuRecord,
  SkuStockFilters, SkuStockView, StockStatus, ValidationReport,
} from "@siteindex/shared";
import rawFixtures from "./data.json";

export interface MockFixtures {
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

export const fixtures = rawFixtures as unknown as MockFixtures;
export type MockProjectId = "kingsyard" | "riverstone";
export const projectKey = (id: ProjectId): MockProjectId => id === "riverstone" ? "riverstone" : "kingsyard";
export const FIXED_TODAY = "2026-10-22";
export const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
export const mockMode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("mock") : null;
export const errorMode = mockMode === "error";
export const performanceMode = mockMode === "perf";
export const loadingMode = mockMode === "loading";
export const slowMode = mockMode === "slow";
export const projectCenterErrorMode = mockMode === "project-center-error";
export const mockApiError: SiteIndexError = {
  code: "UNKNOWN",
  message: "模拟接口错误：请移除地址中的 ?mock=error 后重试。",
};
export const projectCenterError = (): SiteIndexError => ({
  code: "PROJECT_UNREADABLE",
  message: "模拟项目中心数据错误：请移除地址中的 ?mock=project-center-error 后重试。",
});
export const dateBefore = (days: number): string => {
  const date = new Date(FIXED_TODAY + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

export const birdTopics = ["Cardinals", "Blue Jays", "Goldfinches", "Chickadees", "Woodpeckers", "Hummingbirds", "Finches", "Robins", "Nuthatches", "Wrens", "Doves"];
export const generatedBlogs: BlogPost[] = Array.from({ length: 44 }, (_, index) => {
  const topic = birdTopics[index % birdTopics.length]!;
  const title = index % 3 === 0 ? "How to Attract " + topic + " to Your Yard"
    : index % 3 === 1 ? "What Do " + topic + " Eat?" : "Best Feeders for " + topic;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + (index >= birdTopics.length ? "-" + (index + 1) : "");
  const noLinks = index % 11 === 0;
  const noSchema = index % 10 === 7;
  const linksOutOfStock = index % 9 === 3 && index < 39 ? ["feeder-12"] : [];
  return {
    url: "http://127.0.0.1:8765/blog/" + slug, slug, title, published_at: dateBefore(1 + index * 5),
    updated_at: index % 4 === 0 ? dateBefore(index) : null, category: index % 2 ? "Bird Guides" : "Backyard Birds",
    author: "SiteIndex Editorial", tags: [topic.toLowerCase(), "bird feeders"],
    meta_description: "Helpful tips for " + topic.toLowerCase() + " and a healthier backyard habitat.",
    word_count: 600 + index * 73, reading_minutes: 4 + Math.floor(index / 4), outline: ["Overview", "What to prepare", "Practical tips"],
    has_faq: !noSchema, featured_image: null, primary_keyword: index % 13 === 4 ? null : topic.toLowerCase() + " bird feeder",
    links_internal: noLinks ? [] : ["http://127.0.0.1:8765/collections/bird-feeders", "http://127.0.0.1:8765/blog/bird-feeder-guide"],
    links_products: noLinks || index % 7 === 0 ? [] : ["window-feeder", "feeder-12"], links_in: index % 7,
    linked_out_of_stock: linksOutOfStock, last_crawled: dateBefore(index % 5),
  };
});
export const generatedKeywords: Keyword[] = Array.from({ length: 50 }, (_, index) => {
  const topic = birdTopics[index % birdTopics.length]!.toLowerCase();
  const modifier = ["bird feeder", "backyard birds", "feeding tips", "best feeder", "bird bath"][Math.floor(index / birdTopics.length) % 5]!;
  const keyword = topic + " " + modifier + (index >= birdTopics.length * 4 ? " " + (index + 1) : "");
  return {
    keyword, target_url: index % 13 === 0 ? null : "http://127.0.0.1:8765/blog/" + topic.replaceAll(" ", "-") + "-bird-feeder-guide",
    role: index % 5 === 0 ? "secondary" : "primary", intent: index % 3 === 0 ? "informational" : "commercial",
    cluster: topic + " care", status: index < 11 ? "planned" : "live",
    priority: index % 8 === 0 ? 1 : null, source: "内容规划", note: index % 9 === 0 ? "核心词待补目标页" : null,
    search_volume: 320 + index * 47, difficulty: 18 + (index * 7) % 65, current_rank: index % 6 === 0 ? null : 4 + index,
    rank_checked_at: dateBefore(index % 12), updated_at: dateBefore(index % 30),
  };
});
export const delay = async (): Promise<void> => {
  if (loadingMode) await new Promise((resolve) => setTimeout(resolve, 10000));
  else if (slowMode) await new Promise((resolve) => setTimeout(resolve, 300));
  else if (!performanceMode) await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 201)));
  if (errorMode) throw mockApiError;
};
export const reply = async <T,>(value: T | (() => T)): Promise<T> => {
  await delay();
  return clone(typeof value === "function" ? (value as () => T)() : value);
};

export const statusChars: Record<StockStatus, string> = { in_stock: "i", out_of_stock: "o", preorder: "p", unknown: "u" };
export const statusNames: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
export const generatedStatus = (index: number): StockStatus => {
  const value = (index * 37 + 11) % 100;
  if (value < 70) return "in_stock";
  if (value < 88) return "out_of_stock";
  if (value < 96) return "preorder";
  return "unknown";
};

export function makeHistory(index: number, current: StockStatus): string {
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

export function rowFromSku(record: SkuRecord, history: string, since: string): SkuStockView {
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
    parent_sku: record.sku.match(/^(.+?)-[A-Z]$/)?.[1] ?? null,
    price_history: (() => {
      const skuNumber = Number(record.sku.match(/\d+$/)?.[0] ?? 0);
      return [
        { date: dateBefore(60), price: record.price + (skuNumber % 3 === 0 ? 2.25 : 0) },
        { date: dateBefore(18), price: record.price + (skuNumber % 7 === 0 ? -1.5 : 0) },
        { date: FIXED_TODAY, price: record.price },
      ];
    })(),
  };
}

export const categorySeeds: Category[] = fixtures.categories.map((category) => ({
  slug: category.slug, name: category.name, url: category.url, parent: category.parent ?? null,
  source: "feed", product_count: category.product_count ?? 0, sku_count: 0, in_stock_count: 0, last_seen: category.last_seen,
}));
export const stockSeeds = new Map(fixtures.stock.map((row) => [row.sku, row]));
export const recordsByProject: Record<MockProjectId, SkuRecord[]> = { kingsyard: [], riverstone: [] };
export const rowsByProject: Record<MockProjectId, SkuStockView[]> = { kingsyard: [], riverstone: [] };
export const todaySkus: Record<MockProjectId, Set<string>> = { kingsyard: new Set(), riverstone: new Set() };
export const split = Math.ceil(fixtures.generatedSkuCount / 2);
export const categoryNames: Category[] = categorySeeds.length > 0
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

export const productsByProject: Record<MockProjectId, ProductView[]> = {
  kingsyard: fixtures.products.map((row) => clone(row)),
  riverstone: fixtures.products.map((row) => ({
    ...clone(row), handle: "riverstone-" + row.handle, product_id: "RS-" + row.product_id,
    title: "Riverstone Outdoor " + row.title.replace(/^Kingsyard\s*/i, ""),
    url: "https://riverstoneoutdoor.com/products/riverstone-" + row.handle, currency: "USD", tags: [],
  })),
};

export function defaultSchedule(): ScheduleConfig {
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

export function defaultConfig(id: ProjectId): SiteConfig {
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
    categories: {
      mode: kingsyard ? "manual" : "url_rule",
      watched: kingsyard ? [{ name: "Bird Feeders", slug: "bird-feeders", url: "https://" + domain + "/bird-feeders.html" }] : [],
    },
    sku_grouping: kingsyard ? { enabled: true, rule: { type: "regex", value: "^(.+?)-[A-Z]$" } } : { enabled: false, rule: { type: "separator", value: "-" } },
    workspace_folders: [],
    schedule: defaultSchedule(),
  };
}

export const projectConfigs: Record<MockProjectId, SiteConfig> = { kingsyard: defaultConfig("kingsyard"), riverstone: defaultConfig("riverstone") };
export const projectIds: MockProjectId[] = ["kingsyard", "riverstone"];
export const makeProjectSummary = (id: MockProjectId): ProjectSummary => {
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
export const projectSummaries: Record<MockProjectId, ProjectSummary> = { kingsyard: makeProjectSummary("kingsyard"), riverstone: makeProjectSummary("riverstone") };
export const projectsChanged = new Set<(id: ProjectId) => void>();
export const notifyProjectChanged = (id: ProjectId): void => projectsChanged.forEach((callback) => callback(id));

export const settingsState: AppSettings = {
  device_id: "mock-device", device_name: "Henry-PC", projects_root: mockMode === "empty-root" ? "" : "D:/云盘/projects",
  extra_projects: [], cache_dir: "C:/SiteIndex/Cache", browser: { channel: "msedge", executable_path: null },
  notify: { on_failure: true, on_success: false, oos_threshold: 0.12, dingtalk_webhook: null },
  skill_platforms: [
    { id: "claude-code", name: "Claude Code", dir: "%USERPROFILE%/.claude/skills", detected: true },
    { id: "codex", name: "Codex", dir: "[首次使用时确认路径]", detected: false },
    { id: "qwenpaw", name: "qwenpaw", dir: "D:/qwenpaw/workspace/ops-agent/skills", detected: false },
  ],
  conflict_patterns: ["*.conflict-*", "*.copy"],
};
export const mockSkills: SkillInfo[] = [
  { name: "edm-builder", version: "1.2.0", description: "按主题选品，生成可粘贴到 Mailchimp 的 EDM HTML，登记推品记录", has_update: true, reads: ["index/views/products.jsonl", "index/ledgers/edm_campaigns.jsonl", "index/ledgers/promotions.jsonl"], writes: ["edm/{date}-{slug}/", "index/ledgers/edm_campaigns.jsonl"] },
  { name: "stock-report", version: "1.0.0", description: "库存日报、周报、趋势分析（只读）", has_update: false, reads: ["index/reports/daily/", "index/inventory/", "index/logs/runs.jsonl"], writes: [] },
  { name: "blog-writer", version: "1.1.0", description: "选题、蚕食检查、brief、带内链正文、关键词登记", has_update: true, reads: ["index/content/*", "index/seo/pages.jsonl", "index/seo/links.jsonl", "index/views/products.jsonl"], writes: ["内容/drafts/{date}-{slug}/", "index/content/keywords.jsonl"] },
  { name: "link-prospect", version: "1.0.0", description: "外链搜集 → linkflow + 去重台账", has_update: false, reads: ["index/site.json", "index/ledgers/outreach.jsonl"], writes: ["linkflow（MCP）", "index/ledgers/outreach.jsonl"] },
  { name: "sku-media-enrich", version: "1.0.0", description: "Mailchimp 图片匹配、标签与优先级", has_update: false, reads: ["index/catalog/skus.jsonl"], writes: ["index/ledgers/sku_media.csv", "index/ledgers/sku_tags.csv"] },
  { name: "page-design", version: "1.0.0", description: "按网站设计规范做页面、Banner、邮件模板", has_update: false, reads: ["index/design/tokens.json", "index/design/brand.md"], writes: ["设计/"] },
  { name: "project-readme", version: "1.0.0", description: "更新 README 用户区块并保留自动区块", has_update: false, reads: ["README.md"], writes: ["README.md 用户区块"] },
];
export const mockSkillBodies: Record<string, string> = {
  "edm-builder": "# edm-builder\n1. 确认主题、产品数、折扣码与 CTA。\n2. siteindex query · products --in-stock --tag {主题} --json\n   硬性条件：有货、未排除、过冷却期、有图片\n   排序：标签 +3 · 标题/分类 +2 · 优先级 / 2 · 参与活动 +1\n3. 写 brief.md、content.json（文案遵循品牌 voice）。\n4. siteindex edm render · edm/{campaign_id}\n5. siteindex ledger upsert · edm_campaigns --rows -",
  "stock-report": "# stock-report\n先检查 runs.jsonl 最后一次 daily 是否成功。\n日报：结论 → 新到货/新缺货 → 需要行动。\n只读汇报，不修改项目数据。",
  "blog-writer": "# blog-writer\n1. 检查主关键词是否已有目标页面。\n2. 生成大纲与内链计划，只使用数据文件中的 URL。\n3. 写 draft.md 与 meta.json。\n4. 提供反向内链建议。",
  "link-prospect": "# link-prospect\n检查外链候选并排除台账重复项。\n联系方式必须来自页面实际内容。\n完成后更新去重台账。",
  "sku-media-enrich": "# sku-media-enrich\n按 SKU、handle、文件名顺序匹配图片。\n一对多或多对一时先请求确认。\n标签与已有值合并，不覆盖。",
  "page-design": "# page-design\n颜色只使用设计 token 与 palette。\n字体、字号、按钮、间距、圆角遵照项目设计规范。\n规范超过 60 天时提醒重新提取。",
  "project-readme": "# project-readme\n只编辑 README 用户区块，不修改自动区块、index/ 或 _agent/。\n编辑前先展示对比，保存后确认用户区块内容。",
};
export const mockSkillTargets: Record<string, SkillTargetStatus[]> = Object.fromEntries(mockSkills.map((skill) => [skill.name, [
  { target_id: "project:kingsyard", name: "项目 Kingsyard", dir: `D:/云盘/projects/kingsyard/_agent/skills/${skill.name}`, status: skill.has_update ? "outdated" : "latest" },
  { target_id: "claude-code", name: "Claude Code", dir: `~/.claude/skills/${skill.name}`, status: "latest" },
  { target_id: "codex", name: "Codex", dir: null, status: "not_installed" },
  { target_id: "qwenpaw", name: "qwenpaw", dir: `D:/qwenpaw/workspace/ops-agent/skills/${skill.name}`, status: "not_installed" },
]]));
export const folderRows: Record<MockProjectId, FolderRow[]> = {
  kingsyard: [
    { name: "seo", description: "关键词研究、排名周报、站内优化记录", default: true, files: 24, modified_at: "2026-10-19T12:00:00+08:00" },
    { name: "edm", description: "每次 campaign 一个子文件夹（brief、content.json、email.html）", default: true, files: 31, modified_at: "2026-10-20T12:00:00+08:00" },
    { name: "产品", description: "产品图、上新资料、利润测算", default: true, files: 112, modified_at: "2026-10-18T12:00:00+08:00" },
    { name: "内容", description: "博客 brief 与草稿（drafts/），已发布文章存档", default: true, files: 40, modified_at: "2026-10-15T12:00:00+08:00" },
    { name: "设计", description: "", default: true, files: 8, modified_at: "2026-09-30T12:00:00+08:00" },
    { name: "报告", description: "月度钉钉汇报、复盘", default: true, files: 9, modified_at: "2026-10-01T12:00:00+08:00" },
    { name: "广告", description: "Google Ads 素材与投放记录", default: false, files: 14, modified_at: "2026-10-17T12:00:00+08:00" },
  ],
  riverstone: [
    { name: "产品素材", description: "产品图片与规格表。", default: true, files: 12, modified_at: "2026-10-21T12:00:00-07:00" },
    { name: "草稿", description: "待审核的内容草稿。", default: true, files: 2, modified_at: null },
  ],
};
export const mockFileChecks: FileCheck[] = [
  { path: "index/site.json", kind: "config", status: "ok", size: 3482, modified_at: "2026-10-19T14:02:00+08:00" },
  { path: "README.md", kind: "doc", status: "ok", records: 6, size: 8090, modified_at: "2026-10-19T05:00:00+08:00" },
  { path: "_agent/skills/README.md", kind: "doc", status: "ok", records: 7, size: 41984, modified_at: "2026-10-20T09:12:00+08:00" },
  { path: "index/catalog/skus.jsonl", kind: "sync", status: "ok", records: 19, size: 7270, modified_at: "2026-10-20T02:04:00+08:00" },
  { path: "index/catalog/skus (Kingsyard-MBP 的冲突副本).jsonl", kind: "sync", status: "conflict_copy", records: 18, size: 6963, modified_at: "2026-10-19T23:40:00+08:00", rule: "conflict_copy", message: "云盘冲突副本；正式文件正常，可删除", repair: "delete_copy" },
  { path: "index/catalog/product_details.jsonl", kind: "sync", status: "ok", records: 17, size: 12288, modified_at: "2026-10-20T03:01:00+08:00" },
  { path: "index/catalog/categories.json", kind: "sync", status: "ok", records: 4, size: 1229, modified_at: "2026-10-20T03:01:00+08:00" },
  { path: "index/inventory/latest.jsonl", kind: "sync", status: "ok", records: 19, size: 2662, modified_at: "2026-10-20T02:04:00+08:00" },
  { path: "index/inventory/events/2026-10.jsonl", kind: "ledger", status: "missing", size: 0, modified_at: null, rule: "missing", message: "本月库存事件文件缺失", repair: "regenerate:daily" },
  { path: "index/inventory/daily_summary.csv", kind: "view", status: "ok", records: 8, size: 410, modified_at: "2026-10-20T02:04:00+08:00" },
  { path: "index/seo/pages.jsonl", kind: "sync", status: "ok", records: 230, size: 93422, modified_at: "2026-10-20T03:01:00+08:00" },
  { path: "index/seo/issues.jsonl", kind: "sync", status: "error", records: 2, size: 1368, modified_at: "2026-10-20T03:01:00+08:00", rule: "schema", message: "字段 severity 不符合当前 schema", repair: "regenerate:weekly.seo" },
  { path: "index/seo/links.jsonl", kind: "sync", status: "ok", records: 422, size: 51420, modified_at: "2026-10-20T03:01:00+08:00" },
  { path: "index/content/blog_index.jsonl", kind: "sync", status: "ok", records: 28, size: 4887, modified_at: "2026-10-20T03:01:00+08:00" },
  { path: "index/content/keywords.jsonl", kind: "ledger", status: "error", records: 32, size: 2964, modified_at: "2026-10-18T12:00:00+08:00", rule: "sort", message: "记录未按主键排序", repair: "autofix" },
  { path: "index/content/drafts.json", kind: "view", status: "ok", records: 2, size: 960, modified_at: "2026-10-21T12:00:00+08:00" },
  { path: "index/views/home.json", kind: "view", status: "ok", records: 1, size: 804, modified_at: "2026-10-20T03:02:00+08:00" },
  { path: "index/views/category.json", kind: "view", status: "ok", records: 4, size: 1691, modified_at: "2026-10-20T03:02:00+08:00" },
  { path: "index/views/product.json", kind: "view", status: "ok", records: 3, size: 1190, modified_at: "2026-10-20T03:02:00+08:00" },
  { path: "index/design/tokens.json", kind: "sync", status: "ok", records: 1, size: 1906, modified_at: "2026-10-01T13:12:00+08:00" },
  { path: "index/design/screenshots/index.json", kind: "sync", status: "ok", records: 6, size: 422, modified_at: "2026-10-01T13:12:00+08:00" },
  { path: "index/edm/sku_images.jsonl", kind: "sync", status: "ok", records: 19, size: 3086, modified_at: "2026-10-20T02:04:00+08:00" },
  { path: "index/archive/2026-09/manifest.json", kind: "config", status: "ok", records: 1, size: 738, modified_at: "2026-10-01T03:00:00+08:00" },
];
export function summarizeFileChecks(files: FileCheck[]): ValidationReport["summary"] {
  return {
    total: files.length,
    ok: files.filter((file) => file.status === "ok").length,
    error: files.filter((file) => file.status === "error").length,
    missing: files.filter((file) => file.status === "missing").length,
    conflict_copy: files.filter((file) => file.status === "conflict_copy").length,
  };
}
export const fileReports: Record<MockProjectId, ValidationReport> = {
  kingsyard: { checked_at: "2026-10-23T02:30:00+08:00", trigger: "schedule", summary: summarizeFileChecks(mockFileChecks), files: clone(mockFileChecks) },
  riverstone: { checked_at: "2026-10-23T02:30:00+08:00", trigger: "schedule", summary: summarizeFileChecks(mockFileChecks), files: clone(mockFileChecks) },
};
export const userReadmeBlocks: Record<MockProjectId, { overview: string; focus: string; rules: string }> = {
  kingsyard: {
    overview: "Wild bird feeding supplies for backyard birders.\n- 网站：https://www.kingsyard.com（magento）\n- 目标市场：US\n- 目标人群：Backyard bird lovers and gift buyers",
    focus: "- 10 月：Halloween / 秋季喂鸟季 EDM\n- 补齐吸鸟指南类博客",
    rules: "- 工作成果放入用户指定的位置，不要写入 index/（台账除外）\n- 数据缺失或冲突时停下来询问，不要编造 SKU、价格、库存、图片 URL\n- EDM 文案用英文，subject ≤ 50 字符",
  },
  riverstone: { overview: "为庭院和户外生活提供耐用装备。", focus: "维护商品资料与季节性内容。", rules: "说明要简洁、具体。" },
};
export const designTokens: DesignTokens = {
  extracted_at: "2026-10-01T13:12:00-07:00",
  source_pages: ["https://www.kingsyard.com/", "https://www.kingsyard.com/bird-feeders", "https://www.kingsyard.com/products/feeder"],
  css_variables: {
    "--color-primary": "#2F5D3A", "--color-text": "#222222", "--color-text-muted": "#6B6B6B",
    "--color-background": "#FFFFFF", "--color-surface": "#F6F4EF", "--color-border": "#E5E2DA", "--color-sale": "#C0392B",
  },
  color: {
    primary: "#2F5D3A", text: "#222222", text_muted: "#6B6B6B", background: "#FFFFFF",
    surface: "#F6F4EF", border: "#E5E2DA", sale: "#C0392B",
    palette: [
      { value: "#FFFFFF", count: 30 }, { value: "#222222", count: 18 }, { value: "#2F5D3A", count: 12 },
      { value: "#F6F4EF", count: 10 }, { value: "#6B6B6B", count: 8 }, { value: "#E5E2DA", count: 6 },
      { value: "#C0392B", count: 4 }, { value: "#8DA07A", count: 3 }, { value: "#D9B26F", count: 3 },
      { value: "#4A7C59", count: 2 }, { value: "#B5502C", count: 2 }, { value: "#1D3A25", count: 2 },
    ],
  },
  typography: {
    font_families: { heading: "Lora, serif", body: "Inter, sans-serif" },
    scale: {
      h1: { size: "40px", weight: 700, line_height: "48px" },
      h2: { size: "28px", weight: 600, line_height: "36px" },
      h3: { size: "20px", weight: 600, line_height: "28px" },
      body: { size: "16px", weight: 400, line_height: "26px" },
      small: { size: "13px", weight: 400, line_height: "20px" },
    },
  },
  spacing: ["4", "8", "12", "16", "24", "32", "48"],
  radius: ["4px", "8px", "999px"],
  shadow: ["0 2px 8px rgba(0,0,0,.08)"],
  components: {
    button_primary: { background: "#2F5D3A", color: "#FFFFFF", radius: "4px", padding: "12px 24px", weight: 600 },
    button_secondary: { background: "#FFFFFF", color: "#2F5D3A", border: "1px solid #2F5D3A", radius: "4px", padding: "12px 24px", weight: 600 },
    input: { border: "#E5E2DA", radius: "4px", height: "44px", color: "#6B6B6B", padding: "0 14px" },
  },
  assets: { logo: null, favicon: null },
  email_safe: { font_stack: "Arial, Helvetica, sans-serif", button_color: "#2F5D3A" },
};
export const designScreenshotNames = ["首页 · 桌面", "分类 · 桌面", "产品 · 桌面", "首页 · 手机", "分类 · 手机", "产品 · 手机"];
export const designScreenshots = (id: ProjectId): { name: string; path: string }[] => {
  const root = id === "kingsyard" ? "D:/云盘/projects/Kingsyard" : "D:/云盘/projects/Riverstone-Outdoor";
  return designScreenshotNames.map((name, index) => ({
    name,
    path: root + "/" + PATHS.designScreenshots + "/" + ["home-desktop", "category-desktop", "product-desktop", "home-mobile", "category-mobile", "product-mobile"][index] + ".png",
  }));
};
export const initialManualCategories: NonNullable<CategoriesConfig["manual"]> = [
  { slug: "bird-feeders", name: "Bird Feeders", url: "/bird-feeders.html", match: [{ type: "product_type_contains", value: "Bird Feeders" }] },
  { slug: "bird-houses", name: "Bird Houses", url: "/bird-houses.html", match: [{ type: "product_type_contains", value: "Bird Houses" }] },
  { slug: "bird-baths", name: "Bird Baths", url: "/bird-baths.html", match: [{ type: "product_type_contains", value: "Bird Baths" }, { type: "sku_prefix", value: "KYBB" }] },
  { slug: "hummingbird-feeders", name: "Hummingbird Feeders", url: "/hummingbird-feeders.html", match: [{ type: "url_contains", value: "hummingbird" }] },
];
export const categoryConfigs: Record<MockProjectId, CategoriesConfig> = {
  kingsyard: { mode: "manual", manual: initialManualCategories },
  riverstone: { mode: "url_rule", url_pattern: "/collections/:category" },
};
export const tagsByHandle = new Map<string, string[]>();
export const manualImages = new Map<string, string | null>();
export const tagNamesByProject: Record<MockProjectId, Set<string>> = {
  kingsyard: new Set(productsByProject.kingsyard.flatMap((product) => product.tags)),
  riverstone: new Set(productsByProject.riverstone.flatMap((product) => product.tags)),
};
for (const projectId of ["kingsyard", "riverstone"] as const) {
  for (const [index, record] of recordsByProject[projectId].entries()) {
    if ((index === 3 || index === 4) && record.image_url) manualImages.set(projectId + ":" + record.sku, "https://mcusercontent.com/siteindex/demo/" + record.sku + ".jpg");
  }
}
export function mockFeedImageUrl(record: SkuRecord): string | null {
  if (!record.image_url) return null;
  try { return "https://www.kingsyard.com" + new URL(record.image_url).pathname; }
  catch { return record.image_url; }
}
export function edmImageRows(id: ProjectId): SkuImageRow[] {
  const key = projectKey(id);
  const records = recordsByProject[key].slice(0, fixtures.skus.length);
  const stockBySku = new Map(rowsByProject[key].map((row) => [row.sku, row.stock_status]));
  return records.map((record, index) => {
    const manual = manualImages.get(id + ":" + record.sku) ?? null;
    const feed = index === 4 || index === 18 ? null : mockFeedImageUrl(record);
    return {
      sku: record.sku, title: record.title, variant_title: record.variant_title,
      stock_status: stockBySku.get(record.sku) ?? "unknown", feed_image_url: feed,
      manual_image_url: manual, used: manual ? "manual" : feed ? "feed" : "none",
    };
  });
}
export const runners: Record<MockProjectId, RunnerInfo | null> = {
  kingsyard: { device_id: "mock-device", device_name: "Henry-PC", claimed_at: "2026-10-20T09:00:00+08:00" },
  riverstone: null,
};
export const scheduleStates: Record<MockProjectId, ScheduleState> = {
  kingsyard: { config: defaultSchedule(), registered: true, next_runs: [{ job: "daily", at: "2026-10-23T02:00:00+08:00" }] },
  riverstone: { config: defaultSchedule(), registered: false, next_runs: [{ job: "daily", at: "2026-10-23T02:00:00+08:00" }] },
};

export function makeSeoPage(input: Pick<SeoPage, "url" | "page_type"> & Partial<SeoPage>): SeoPage {
  const title = input.title ?? null;
  const description = input.meta_description ?? null;
  const canonical = input.canonical === undefined ? input.url : input.canonical;
  const statusCode = input.status_code ?? 200;
  return {
    url: input.url, page_type: input.page_type, status_code: statusCode,
    final_url: input.final_url === undefined ? input.url : input.final_url,
    redirect_chain: input.redirect_chain ?? [], response_ms: input.response_ms ?? 238,
    title, title_length: input.title_length ?? title?.length ?? 0,
    meta_description: description, description_length: input.description_length ?? description?.length ?? 0,
    meta_keywords: input.meta_keywords ?? "bird feeders, outdoor living",
    h1: input.h1 === undefined ? title : input.h1, h1_count: input.h1_count ?? (input.h1 ?? title ? 1 : 0),
    h2: input.h2 ?? ["产品特点", "配送与退货"], canonical,
    canonical_status: input.canonical_status ?? (canonical === input.url ? "self" : canonical ? "other" : "missing"),
    robots_meta: input.robots_meta ?? null, x_robots_tag: input.x_robots_tag ?? null,
    indexable: input.indexable ?? statusCode < 400, in_sitemap: input.in_sitemap ?? true,
    google_indexed: "google_indexed" in input ? input.google_indexed : true,
    index_checked_at: "index_checked_at" in input ? input.index_checked_at : FIXED_TODAY,
    hreflang: input.hreflang ?? [{ lang: "en-US", url: input.url }],
    og: input.og ?? { title, description }, twitter_card: input.twitter_card ?? "summary_large_image",
    schema_types: input.schema_types ?? ["WebPage"], schema_errors: input.schema_errors ?? [],
    word_count: input.word_count === undefined ? 348 : input.word_count,
    images_total: input.images_total ?? 8, images_missing_alt: input.images_missing_alt ?? 0,
    links_internal_out: input.links_internal_out ?? 5, links_external_out: input.links_external_out ?? 1,
    links_internal_in: input.links_internal_in ?? 3, last_crawled: input.last_crawled ?? FIXED_TODAY,
  };
}

export function pageFromSeed(seed: MockFixtures["pages"][number]): SeoPage {
  const schemaTypes = seed.type === "home" ? ["Organization", "WebSite"] : seed.type === "collection" ? ["CollectionPage", "BreadcrumbList"] : ["WebPage"];
  return makeSeoPage({
    url: seed.url, page_type: seed.type as SeoPage["page_type"], status_code: seed.status_code,
    title: seed.title, meta_description: seed.meta_description, h1: seed.h1,
    canonical: seed.canonical, indexable: seed.indexable, word_count: seed.word_count,
    last_crawled: seed.last_crawled, schema_types: schemaTypes,
    robots_meta: seed.indexable ? null : "noindex, follow",
    in_sitemap: seed.url.endsWith("/about-us") ? false : true,
    google_indexed: seed.url.endsWith("/shipping-policy") ? null : seed.indexable,
  });
}
export const seoPages = [
  ...fixtures.pages.map(pageFromSeed),
  makeSeoPage({
    url: "http://127.0.0.1:8765/window-feeder.html", page_type: "product",
    title: "Kingsyard Window Feeder | Outdoor Bird Feeder", meta_description: null, h1: "Window Feeder",
    schema_types: ["Product", "BreadcrumbList"], images_total: 6, images_missing_alt: 1,
  }),
  makeSeoPage({
    url: "http://127.0.0.1:8765/feeder-12", page_type: "product", title: "Feeder 12 | Kingsyard",
    meta_description: "Explore our durable feeder.", canonical: "http://127.0.0.1:8765/clearance-feeder",
    canonical_status: "other", schema_types: ["Product"], google_indexed: false,
  }),
  makeSeoPage({
    url: "http://127.0.0.1:8765/blog/clean-bird-bath", page_type: "blog",
    title: "How to Clean a Bird Bath | Kingsyard", meta_description: "A practical guide to cleaning a bird bath.",
    schema_types: [], word_count: 15, links_internal_in: 0,
  }),
  makeSeoPage({
    url: "http://127.0.0.1:8765/blog/missing-post", page_type: "blog", status_code: 404,
    title: null, meta_description: null, h1: null, h1_count: 0, indexable: false, in_sitemap: true,
    google_indexed: false, schema_types: [], word_count: 0, images_total: 0, links_internal_out: 0, links_internal_in: 0,
  }),
  makeSeoPage({
    url: "http://127.0.0.1:8765/help/orphan-page", page_type: "page",
    title: "Bird Feeder Guide | Kingsyard", meta_description: "Help for choosing bird feeders.",
    schema_types: ["WebPage"], links_internal_in: 0, google_indexed: true,
  }),
];
export const seoIssues: SeoIssue[] = [
  { url: "http://127.0.0.1:8765/blog/missing-post", rule: "http_4xx", severity: "high", detail: "页面 404，仍出现在 sitemap 中", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "http://127.0.0.1:8765/shipping-policy", rule: "canonical_other", severity: "mid", detail: "Canonical 指向 /shipping-policy-old", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "http://127.0.0.1:8765/window-feeder.html", rule: "desc_missing", severity: "mid", detail: "Meta description 缺失 · 新上架产品页", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "http://127.0.0.1:8765/blog/clean-bird-bath", rule: "schema_missing", severity: "mid", detail: "缺少 Article / BlogPosting schema", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "http://127.0.0.1:8765/about-us", rule: "noindex", severity: "low", detail: "noindex · 确认是否有意不收录", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "http://127.0.0.1:8765/blog/clean-bird-bath", rule: "thin_content", severity: "low", detail: "内容过短且无站内链接 · 15 词", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
  { url: "http://127.0.0.1:8765/", rule: "title_length", severity: "low", detail: "Title 过短 · 16 字符，建议 30–60", status: "open", first_seen: "2026-10-20", last_seen: FIXED_TODAY },
];
export const seoLinks: SeoLink[] = [
  { from: "http://127.0.0.1:8765/", to: "http://127.0.0.1:8765/bird-feeders.html", anchor: "Bird Feeders", to_type: "collection" },
  { from: "http://127.0.0.1:8765/", to: "http://127.0.0.1:8765/bird-houses.html", anchor: "Bird Houses", to_type: "collection" },
  { from: "http://127.0.0.1:8765/bird-feeders.html", to: "http://127.0.0.1:8765/window-feeder.html", anchor: "Window Feeder", to_type: "product" },
  { from: "http://127.0.0.1:8765/bird-feeders.html", to: "http://127.0.0.1:8765/feeder-12", anchor: "Clearance Feeder", to_type: "product" },
  { from: "http://127.0.0.1:8765/blog/clean-bird-bath", to: "http://127.0.0.1:8765/bird-feeders.html", anchor: "Browse feeders", to_type: "collection" },
  { from: "http://127.0.0.1:8765/shipping-policy", to: "http://127.0.0.1:8765/", anchor: "Home", to_type: "page" },
];
export const orphanSeoPages = ["http://127.0.0.1:8765/help/orphan-page"];

export function inventorySummary(id: ProjectId, range: HistoryRange | 14 = 30): InventorySummary {
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
  const days = typeof range === "number" ? range : 90;
  const availableDays = Math.min(days, 1);
  const dates = Array.from({ length: availableDays }, (_, index) => dateBefore(availableDays - index - 1));
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
  }).sort((left, right) => categoryPriority(left.category) - categoryPriority(right.category));
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
    trend: { dates, series: trendSeries }, category_rates: categoryRates, timezone: projectConfigs[key].timezone,
    category_source: categoryConfigs[key].mode,
    uncategorized: rows.filter((row) => !row.category).length, today,
  };
}

const searchIndexCache = new WeakMap<readonly unknown[], readonly string[]>();

export function selectRows<T, F = Record<string, unknown>>(
  source: readonly T[], query: ListQuery<F>, searchText: (row: T) => string,
  matches: (row: T, filters: F) => boolean = () => true,
): PageResult<T> {
  const search = query.search?.trim().toLocaleLowerCase();
  let searchIndex = search ? searchIndexCache.get(source) : undefined;
  if (search && !searchIndex) {
    searchIndex = source.map((row) => searchText(row).toLocaleLowerCase());
    searchIndexCache.set(source, searchIndex);
  }
  let rows = source.filter((row, index) =>
    (!search || searchIndex?.[index]?.includes(search)) && matches(row, (query.filters ?? {}) as F),
  );
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

export function productRows(id: ProjectId): ProductView[] {
  return productsByProject[projectKey(id)].map((row) => ({ ...row, image_url: null, feed_image_url: null, manual_image_url: null, image_source: "none", tags: tagsByHandle.get(id + ":" + row.handle) ?? row.tags }));
}
export const progressListeners = new Set<(progress: JobProgress) => void>();
export const finishedListeners = new Set<(result: JobResult) => void>();
export const activeRuns = new Map<string, { projectPath: string; job: JobName; timer: ReturnType<typeof setInterval>; pct: number }>();
export let runCounter = 0;
export const runHistory: RunLog[] = [
  { run_id: "mock-daily-today", job: "daily", trigger: "schedule", device_name: "Henry-PC", started_at: "2026-10-22T02:04:00+08:00", finished_at: "2026-10-22T02:05:16+08:00", status: "ok", counts: { restock: 1, out_of_stock: 2, price: 1, new: 1 } },
  { run_id: "mock-validate-today", job: "validate", trigger: "schedule", device_name: "Henry-PC", started_at: "2026-10-22T02:30:00+08:00", finished_at: "2026-10-22T02:30:08+08:00", status: "partial", errors: ["0 个错误 · unknown 库存 1/19（5.3%）"] },
  { run_id: "mock-daily-yesterday", job: "daily", trigger: "schedule", device_name: "Henry-PC", started_at: "2026-10-21T02:03:00+08:00", finished_at: "2026-10-21T02:04:12+08:00", status: "ok" },
  ...fixtures.runs,
];

export function finishRun(runId: string, status: "ok" | "skipped" = "ok"): void {
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

export function beginRun(projectPath: string, job: JobName): string {
  runCounter += 1;
  const runId = "mock-run-" + String(runCounter).padStart(3, "0");
  const active = { projectPath, job, pct: 0, timer: 0 as unknown as ReturnType<typeof setInterval> };
  if (job === "init") {
    const dailyFails = mockMode === "init-daily-fail";
    const dailyError = "首次每日同步失败：模拟 Feed 请求超时。";
    let index = 0;
    active.timer = setInterval(() => {
      const key = INIT_STEPS[index];
      if (!key) return;
      index += 1;
      active.pct = Math.round(index / INIT_STEPS.length * 100);
      progressListeners.forEach((callback) => callback({
        runId, projectPath, job, pct: active.pct, step: key,
        level: dailyFails && key === "daily" ? "error" : "info",
        message: dailyFails && key === "daily" ? dailyError : `正在执行 ${key} 步骤`,
        at: new Date().toISOString(),
      }));
      if (index < INIT_STEPS.length) return;
      clearInterval(active.timer);
      activeRuns.delete(runId);
      const result: JobResult = {
        runId, job, status: dailyFails ? "partial" : "ok", exitCode: dailyFails ? 1 : 0,
        summary: dailyFails ? "创建完成，但有步骤失败" : "项目创建完成",
        errors: dailyFails ? [dailyError] : [],
        steps: INIT_STEPS.map((step) => ({ key: step, status: dailyFails && step === "daily" ? "failed" as const : "ok" as const, ...(dailyFails && step === "daily" ? { message: dailyError } : {}) })),
      };
      runHistory.unshift({ run_id: runId, job, trigger: "manual", device_name: "本地开发工作站", started_at: "2026-10-22T10:00:00+08:00", finished_at: "2026-10-22T10:00:03+08:00", status: result.status, errors: result.errors });
      finishedListeners.forEach((callback) => callback(clone(result)));
    }, 300);
    activeRuns.set(runId, active);
    return runId;
  }
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
