/**
 * 界面 ↔ 主进程契约：window.siteindex 的完整接口。
 * - ui（工作流 B）只依赖本文件；浏览器开发时用 mock 实现它
 * - desktop（工作流 C）在 preload 暴露、在 main 用 @siteindex/core 实现它
 * - core（工作流 A）提供实现所需的查询与操作函数
 * 所有方法返回 Promise；失败时 reject 一个 SiteIndexError（见 errors.ts）。
 * 修改需走契约流程（docs/WORKSTREAMS.md §4）。
 */
import type {
  BlogPost,
  CategoryMode,
  DesignTokens,
  FileCheck,
  ISODate,
  ISODateTime,
  Keyword,
  ManualCategory,
  PageType,
  Platform,
  ProductDetails,
  ProductView,
  RepairAction,
  RunLog,
  RunnerInfo,
  ScheduleConfig,
  SeoIssue,
  SeoLink,
  SeoPage,
  Severity,
  SiteConfig,
  SkuRecord,
  SkuStockView,
  StockStatus,
  ValidationReport,
} from "./models";
import type { JobProgress, JobRequest, JobResult } from "./jobs";

// ---------- 通用 ----------

export type ProjectId = string; // 项目文件夹名的 slug
export type Unsubscribe = () => void;

export interface ListQuery<F = Record<string, unknown>> {
  page: number; // 从 1 开始
  pageSize: number; // 20 / 50 / 100；传 0 表示不分页（导出用）
  search?: string;
  sort?: { field: string; dir: "asc" | "desc" };
  filters?: F;
}

export interface PageResult<T> {
  rows: T[];
  total: number;
}

export interface Kpi {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger";
  reserved?: boolean; // 预留指标（虚线卡片）
  link?: string; // 路由，如 "/p/kingsyard/inventory"
}

// ---------- 软件设置 ----------

export interface SkillPlatform {
  id: string; // "claude-code" | "codex" | 自定义
  name: string;
  dir: string;
  detected: boolean;
}

export interface AppSettings {
  device_id: string;
  device_name: string;
  projects_root: string;
  extra_projects: string[];
  cache_dir: string;
  browser: { channel: "msedge" | "chrome" | "custom"; executable_path: string | null };
  notify: { on_failure: boolean; on_success: boolean; oos_threshold: number | null; dingtalk_webhook: string | null };
  skill_platforms: SkillPlatform[];
  conflict_patterns: string[];
}

export interface BrowserStatus {
  available: boolean;
  name: string | null; // "Microsoft Edge 141"
  path: string | null;
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
}

// ---------- 项目 ----------

export type SyncState = "ok" | "partial" | "failed" | "never" | "running";

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  path: string;
  domain: string;
  platform: Platform;
  sync: { state: SyncState; at: ISODateTime | null; job: string | null };
  sku_count: number;
  product_count: number;
  online_rate: number | null; // 0–1
  blog_count: number;
  today: { restock: number; oos: number; price: number; new: number; removed: number };
  attention: number; // 待处理提醒数
  warnings: string[]; // 卡片上的异常说明，如 "尚未填写 GMC feed"
  runner_device: string | null;
  is_runner: boolean;
}

export interface ProjectDetail {
  summary: ProjectSummary;
  config: SiteConfig;
  runner: RunnerInfo | null;
}

export interface DetectResult {
  input: string;
  final_url: string;
  redirect_status: number | null;
  robots: { found: boolean; disallow_count: number; sitemaps: string[] };
  sitemaps: { url: string; type: "index" | "urlset"; url_count: number }[];
  total_urls: number;
  platform: Platform;
  platform_evidence: string;
  frontend: string | null;
  locale: string | null;
  currency: string | null;
  feed_candidates: string[];
}

export interface FeedInspectResult {
  items: number;
  usable_skus: number;
  products: number;
  skipped: { duplicate: number; missing_price_or_link: number; no_id: number };
  stock: Record<StockStatus, number>;
  field_coverage: { field: string; pct: number }[];
  category_distribution: { slug: string; count: number }[];
  samples: (Pick<SkuRecord, "sku" | "title" | "variant_title" | "category" | "price"> & {
    stock_status: StockStatus;
  })[];
}

export interface CreateProjectInput {
  url: string;
  feed_urls: string[];
  sku_field: string;
  category_depth: number;
  missing_as: "out_of_stock" | "removed";
  brand: SiteConfig["brand"];
  markets: string[];
  projects_root: string;
  folder_name: string;
  workspace_folders: string[];
}

// ---------- 概览 ----------

export interface AttentionItem {
  severity: Severity;
  text: string;
  link: string;
  link_label: string;
}

export interface OverviewData {
  kpis: Kpi[];
  attention: AttentionItem[];
  readme: { overview: string; focus: string };
  agent_instruction: string; // "进入 …，先完整阅读 README.md …"
  changelog: { date: ISODate; text: string }[];
}

// ---------- 库存 ----------

export interface InventorySummary {
  as_of: ISODate;
  kpis: Kpi[];
  trend: { dates: ISODate[]; series: { category: string; rates: (number | null)[] }[] };
  category_rates: { category: string; rate: number; total: number }[];
  category_source: CategoryMode;
  uncategorized: number;
  today: { type: "restock" | "oos" | "price" | "new" | "removed"; sku: string; title: string; detail?: string }[];
}

export interface SkuStockFilters {
  status?: StockStatus | "today";
  category?: string;
}

// ---------- 产品 ----------

export interface ProductFilters {
  stock?: "in" | "out" | "other";
  tag?: string;
  category?: string;
}

export interface ProductFull {
  product: ProductView;
  skus: SkuRecord[];
  details: ProductDetails | null;
  seo: Pick<SeoPage, "url" | "title" | "robots_meta" | "schema_types" | "google_indexed"> | null;
}

export interface TagStat {
  tag: string;
  products: number;
}

// ---------- SEO ----------

export interface SeoSummary {
  kpis: Kpi[];
  crawled_at: ISODateTime | null;
  title_range: [number, number];
  description_range: [number, number];
}

export interface SeoIssueFilters {
  severity?: Severity;
  status?: SeoIssue["status"];
}

export interface SeoPageFilters {
  page_type?: PageType;
  indexed?: "yes" | "no" | "unchecked";
}

// ---------- 内容 ----------

export interface ContentSummary {
  kpis: Kpi[];
  uncovered_core_keywords: string[];
}

export interface BlogFilters {
  issue?: "no_links" | "no_schema" | "links_oos";
}

export interface KeywordFilters {
  role?: Keyword["role"];
  status?: Keyword["status"];
}

export interface DraftRow {
  date: ISODate;
  slug: string;
  folder: string;
  files: string[];
  status: "brief" | "draft" | "published";
}

// ---------- EDM ----------

export interface SkuImageRow {
  sku: string;
  title: string;
  variant_title: string | null;
  stock_status: StockStatus;
  feed_image_url: string | null;
  manual_image_url: string | null;
  used: "feed" | "manual" | "none";
}

export interface SkuImageFilters {
  view?: "in_stock" | "no_feed" | "has_manual" | "none";
}

export interface EdmCommandInput {
  theme: string;
  count: number;
  promo_code?: string;
}

// ---------- README / 文件夹 / 分类 ----------

export interface ReadmeData {
  user_blocks: { overview: string; focus: string; rules: string };
  auto_blocks: { id: string; title: string; updated_at: ISODateTime | null; schedule: string }[];
  folder_map: FolderRow[];
}

export interface FolderRow {
  name: string;
  description: string; // _about.md 第一段；空 = 待补充说明
  default: boolean;
  files: number;
  modified_at: ISODateTime | null;
}

export interface CategoriesConfig {
  mode: CategoryMode;
  url_pattern?: string;
  manual?: ManualCategory[];
}

export interface CategoryPreview {
  categories: { slug: string; name: string; url: string; sku_count: number }[];
  uncategorized: number;
  multi_matched: number;
  candidates: { url: string; product_links: number; configured: boolean }[]; // 来自 sitemap 的候选分类页
}

// ---------- 运行 / 计划 / 执行设备 ----------

export interface ScheduleState {
  config: ScheduleConfig;
  registered: boolean; // 已注册到系统计划任务
  next_runs: { job: string; at: ISODateTime | null }[];
}

export interface RunnerState {
  runner: RunnerInfo | null;
  this_device: { device_id: string; device_name: string };
  is_this_device: boolean;
}

// ---------- Skill ----------

export interface SkillInfo {
  name: string;
  version: string;
  description: string;
  has_update: boolean; // 项目中的版本落后于软件内置
  reads: string[];
  writes: string[];
}

export interface SkillTargetStatus {
  target_id: string; // "project:kingsyard" | "claude-code" | …
  name: string;
  dir: string | null;
  status: "latest" | "outdated" | "not_installed" | "unknown_path";
}

// ---------- 主接口 ----------

export interface SiteIndexApi {
  app: {
    version(): Promise<string>;
    platform(): Promise<"win32" | "darwin">;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
    detectBrowser(): Promise<BrowserStatus>;
    cliStatus(): Promise<CliStatus>;
    installCli(): Promise<CliStatus>;
    chooseDirectory(defaultPath?: string): Promise<string | null>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(id: ProjectId): Promise<ProjectDetail>;
    detect(url: string): Promise<DetectResult>;
    inspectFeed(feedUrls: string[], opts: { sku_field: string; category_depth: number }): Promise<FeedInspectResult>;
    create(input: CreateProjectInput): Promise<{ id: ProjectId; runId: string }>;
    addExisting(path: string): Promise<ProjectSummary>;
    updateConfig(id: ProjectId, patch: Partial<SiteConfig>): Promise<SiteConfig>;
    onChanged(cb: (id: ProjectId) => void): Unsubscribe;
  };
  overview: {
    get(id: ProjectId): Promise<OverviewData>;
  };
  inventory: {
    summary(id: ProjectId, days?: 14 | 30): Promise<InventorySummary>;
    listSkus(id: ProjectId, q: ListQuery<SkuStockFilters>): Promise<PageResult<SkuStockView>>;
    dailyReport(id: ProjectId, date: ISODate): Promise<string | null>; // Markdown
    exportCsv(id: ProjectId, q: ListQuery<SkuStockFilters>): Promise<string>; // 保存后的文件路径
  };
  products: {
    list(id: ProjectId, q: ListQuery<ProductFilters>): Promise<PageResult<ProductView>>;
    get(id: ProjectId, handle: string): Promise<ProductFull>;
    setTags(id: ProjectId, handle: string, tags: string[]): Promise<string[]>;
    listTags(id: ProjectId): Promise<TagStat[]>;
    createTag(id: ProjectId, tag: string): Promise<TagStat[]>;
    deleteTag(id: ProjectId, tag: string): Promise<TagStat[]>;
    exportCsv(id: ProjectId, q: ListQuery<ProductFilters>): Promise<string>;
  };
  seo: {
    summary(id: ProjectId): Promise<SeoSummary>;
    listIssues(id: ProjectId, q: ListQuery<SeoIssueFilters>): Promise<PageResult<SeoIssue>>;
    listPages(id: ProjectId, q: ListQuery<SeoPageFilters>): Promise<PageResult<SeoPage>>;
    listLinks(id: ProjectId, q: ListQuery): Promise<PageResult<SeoLink>>;
    orphanPages(id: ProjectId): Promise<string[]>;
    getPage(id: ProjectId, url: string): Promise<SeoPage | null>;
    googleSiteUrl(url: string): Promise<string>; // 返回 https://www.google.com/search?q=site:…
    checkIndex(id: ProjectId, urls?: string[]): Promise<{ runId: string }>; // 批量，后台 Job
  };
  content: {
    summary(id: ProjectId): Promise<ContentSummary>;
    listBlog(id: ProjectId, q: ListQuery<BlogFilters>): Promise<PageResult<BlogPost>>;
    listKeywords(id: ProjectId, q: ListQuery<KeywordFilters>): Promise<PageResult<Keyword>>;
    listDrafts(id: ProjectId): Promise<DraftRow[]>;
  };
  edm: {
    summary(id: ProjectId): Promise<{ total: number; feed: number; manual: number; none: number }>;
    listImages(id: ProjectId, q: ListQuery<SkuImageFilters>): Promise<PageResult<SkuImageRow>>;
    setManualImage(id: ProjectId, sku: string, url: string | null): Promise<SkuImageRow>;
    buildCommand(id: ProjectId, input: EdmCommandInput): Promise<string>;
  };
  design: {
    get(id: ProjectId): Promise<{ tokens: DesignTokens | null; screenshots: { name: string; path: string }[] }>;
  };
  readme: {
    get(id: ProjectId): Promise<ReadmeData>;
    saveUserBlocks(id: ProjectId, blocks: ReadmeData["user_blocks"]): Promise<void>;
    refresh(id: ProjectId): Promise<{ runId: string }>;
  };
  categories: {
    get(id: ProjectId): Promise<CategoriesConfig>;
    preview(id: ProjectId, config: CategoriesConfig): Promise<CategoryPreview>;
    save(id: ProjectId, config: CategoriesConfig): Promise<CategoryPreview>; // 保存并重新归类
  };
  folders: {
    list(id: ProjectId): Promise<FolderRow[]>;
    create(id: ProjectId, name: string, description: string): Promise<FolderRow[]>;
    describe(id: ProjectId, name: string, description: string): Promise<FolderRow[]>;
    remove(id: ProjectId, name: string): Promise<FolderRow[]>; // 仅自定义文件夹；移入回收站
    open(id: ProjectId, name?: string): Promise<void>;
  };
  files: {
    lastReport(id: ProjectId): Promise<ValidationReport | null>;
    validate(id: ProjectId, path?: string): Promise<ValidationReport>;
    repair(id: ProjectId, path: string, action: RepairAction): Promise<FileCheck>;
  };
  jobs: {
    run(req: Omit<JobRequest, "trigger">): Promise<{ runId: string }>;
    cancel(runId: string): Promise<void>;
    history(id: ProjectId, limit?: number): Promise<RunLog[]>;
    running(id: ProjectId): Promise<{ runId: string; job: string } | null>;
    onProgress(cb: (p: JobProgress) => void): Unsubscribe;
    onFinished(cb: (r: JobResult) => void): Unsubscribe;
  };
  schedule: {
    get(id: ProjectId): Promise<ScheduleState>;
    save(id: ProjectId, config: ScheduleConfig): Promise<ScheduleState>;
  };
  runner: {
    get(id: ProjectId): Promise<RunnerState>;
    claim(id: ProjectId): Promise<RunnerState>;
  };
  skills: {
    list(): Promise<SkillInfo[]>;
    get(name: string): Promise<{ info: SkillInfo; body: string }>;
    targets(name: string): Promise<SkillTargetStatus[]>;
    install(name: string, targetId: string): Promise<SkillTargetStatus>;
    syncAllProjects(): Promise<void>;
  };
  shell: {
    openPath(path: string): Promise<void>;
    openExternal(url: string): Promise<void>; // 仅 http/https
    copyText(text: string): Promise<void>;
  };
}

declare global {
  interface Window {
    siteindex: SiteIndexApi;
  }
}
