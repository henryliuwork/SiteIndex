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
  EdmSkuIndexExportResult,
  FileCheck,
  HistoryRange,
  InventoryEvent,
  ISODate,
  ISODateTime,
  Keyword,
  ManualCategory,
  PageType,
  Platform,
  ProductDetails,
  ProductVariantStock,
  ProductView,
  RepairAction,
  RunLog,
  RunnerInfo,
  ScheduleConfig,
  SeoIssue,
  SeoRuleSetting,
  SeoLink,
  SeoPage,
  Severity,
  SiteConfig,
  SkuGroupingRule,
  SkuRecord,
  SkuStockView,
  StockStatus,
  ValidationReport,
} from "./models";
import type { ProjectPaths } from "./paths";
import type { JobProgress, JobRequest, JobResult, SchedulableJob } from "./jobs";
import type {
  ProjectTodosResult,
  ScenarioAnomaly,
  ScenarioDataQuality,
  ScenarioQueryResult,
  TodoManualHistoryEntry,
  TodoManualState,
  UpdateTodoManualInput,
} from "./read-model";

// ---------- 通用 ----------

export type ProjectId = string; // 项目文件夹名的 slug
export type Unsubscribe = () => void;

export interface ListQuery<F = Record<string, unknown>> {
  page: number; // 从 1 开始
  pageSize: number; // 标准表格选项为 20 / 50 / 100 / 200；传 0 表示不分页（表格与导出）；保留 number 兼容旧页长调用
  search?: string;
  sort?: { field: string; dir: "asc" | "desc" };
  filters?: F;
}

// ---------- Google Search Console ----------

export type GscAuthorizationState =
  "not_configured" | "disconnected" | "connected" | "reauthorization_required" | "unavailable";

/** Local connection state only. OAuth tokens, account email and raw provider responses are never exposed. */
export interface GscAuthorizationStatus {
  state: GscAuthorizationState;
  reason?: "client_id_missing" | "encryption_unavailable" | "credentials_unreadable" | "refresh_token_rejected";
}

export interface GscProperty {
  site_url: string;
  permission_level: string;
}

/** The account's readable properties and the explicitly selected property for one SiteIndex project. */
export interface GscPropertyListData {
  properties: GscProperty[];
  selected_site_url: string | null;
}

export interface GscPropertySelection {
  site_url: string | null;
}

export type GscSyncMode = "initial_90_days" | "incremental";

export interface GscDateRange {
  start_date: ISODate;
  end_date: ISODate;
}

export interface GscMissingRange extends GscDateRange {
  reason: "no_rows" | "not_yet_available" | "not_returned";
}

export interface GscSyncMetadata {
  data_source: "google_search_console";
  property_site_url: string | null;
  requested_at: ISODateTime;
  collected_at: ISODateTime | null;
  /** Latest Search Console business date included in the response, if available. */
  data_through: ISODate | null;
  requested_range: GscDateRange | null;
  missing_ranges: GscMissingRange[];
  missing_fields: string[];
  quality: ScenarioDataQuality;
  anomalies: ScenarioAnomaly[];
}

interface GscSyncResultBase {
  mode: GscSyncMode;
  records_received: number;
  records_written: number;
  metadata: GscSyncMetadata;
}

/**
 * A failed/blocked sync preserves existing history. Successful and partial batches merge/upsert their dates;
 * neither mode replaces the complete historical dataset.
 */
export type GscSyncResult =
  | (GscSyncResultBase & { state: "complete" | "partial"; history_effect: "merged" })
  | (GscSyncResultBase & {
      state: "blocked" | "failed";
      history_effect: "preserved";
      error: { code: string; message: string };
    });

export interface GscSyncInput {
  /** First import covers the last 90 days of data available from Search Console. */
  mode: GscSyncMode;
}

export type PageSize = 0 | 20 | 50 | 100 | 200;

export interface PageResult<T> {
  rows: T[];
  total: number;
}

/** 父 SKU 是规则推导出的候选父项，且该 SKU 本身存在于 feed；children 为命中它的子 SKU。 */
export interface SkuGroupingCollision {
  parent: string;
  children: string[];
}

/** 父子 SKU 规则预览；counts 仅描述按规则识别出的父/子 SKU，不代表父 SKU 库存。 */
export interface SkuGroupingPreview {
  parents: number;
  children: number;
  samples: { parent: string; children: string[] }[];
  unmatched: number;
  /** 仅报告被现有真实 SKU 阻止的候选分组，不改变归组行为。 */
  collisions?: SkuGroupingCollision[];
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
  id: string; // 内置包括 "claude-code"、"codex"、"agents-dir"，也允许自定义
  name: string;
  dir: string;
  detected: boolean;
}

export interface AppSettings {
  device_id: string;
  device_name: string;
  projects_root: string;
  extra_projects: string[];
  /** 仅用于本机项目中心隐藏；项目文件保持不变。 */
  hidden_projects?: string[];
  close_to_tray?: boolean;
  launch_at_login?: boolean;
  cache_dir: string;
  browser: { channel: "msedge" | "chrome" | "custom"; executable_path: string | null };
  notify: { on_failure: boolean; on_success: boolean; oos_threshold: number | null; dingtalk_webhook: string | null };
  skill_platforms: SkillPlatform[];
  conflict_patterns: string[];
}

/** 本机缓存中的项目界面偏好，不写入项目云盘目录。 */
export interface ProjectUiState {
  columns: Record<string, string[]>;
  page_sizes: Record<string, 20 | 50 | 100>;
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
  /** Only set when the path matches a known sync root; absence does not certify local storage. */
  storage_location?: "known_cloud_sync";
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
  /** @deprecated 2026-10-27 起软件不再管理工作区文件夹（docs/decisions/2026-10-27-data-index-focus.md），待 A/B/C 移除调用后删除。 */
  workspace_folders: string[];
  workspace?: {
    enabled: boolean;
    platform: "magento2" | "woocommerce" | "shopify" | "other";
    esp_presets: string[];
  };
}

export interface WorkspaceCheckResult {
  ok: boolean;
  invalid_entries: string[];
}

export interface WorkspaceCreateInput {
  targetDir: string;
  domain: string;
  brand: SiteConfig["brand"];
  platform: "magento2" | "woocommerce" | "shopify" | "other";
  markets?: string[];
  esp_presets: string[];
}

export interface WorkspaceCreateResult {
  path: string;
  created: string[];
}

export interface WorkspaceImportIssue {
  path: string;
  code: string;
  message: string;
  auto_fixable: boolean;
}

export interface WorkspaceImportCheckResult {
  issues: WorkspaceImportIssue[];
  repaired: string[];
}

export type CreateWorkspaceOnlyInput = Pick<
  CreateProjectInput,
  "url" | "brand" | "markets" | "projects_root" | "folder_name"
> & {
  workspace: NonNullable<CreateProjectInput["workspace"]>;
};

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
  category_rates: { category: string; rate: number; total: number; watched?: boolean; manual?: boolean }[];
  category_source: CategoryMode;
  timezone?: string;
  uncategorized: number;
  today: { type: "restock" | "oos" | "price" | "new" | "removed" | "feed_anomaly"; sku: string; title: string; detail?: string }[];
}

export interface SkuStockFilters {
  status?: StockStatus | "today";
  category?: string;
  parent_only?: boolean;
  watched_only?: boolean;
  price_changed_within?: HistoryRange;
}

// ---------- 产品 ----------

export interface ProductFilters {
  stock?: "in" | "out" | "other";
  tag?: string;
  category?: string;
  parent_only?: boolean;
}

export interface ProductFull {
  product: ProductView;
  skus: SkuRecord[];
  details: ProductDetails | null;
  seo: Pick<SeoPage, "url" | "title" | "robots_meta" | "schema_types" | "google_indexed"> | null;
  variants?: ProductVariantStock[];
}

/** One feed SKU and its latest stored stock view; missing companion records remain null. */
export interface ProductSkuBrief {
  sku: SkuRecord;
  stock: SkuStockView | null;
}

/** A SKU's direct, stored inventory events. An empty array means no events; unavailable data uses a null result envelope. */
export type ProductChanges = InventoryEvent[];

/** Inventory for one real feed SKU that belongs to a returned family. A derived parent may be absent because no parent SKU exists in the feed. */
export interface ProductGroupFamilyMember {
  sku: string;
  role: "parent" | "child" | "single";
  /** Null means this member has no usable stored stock row; the query metadata identifies the missing source or field. */
  stock: SkuStockView | null;
}

/** Stored SKU family relationships; parent identifiers do not imply a parent inventory entity. */
export interface ProductGroupFamily {
  sku: string;
  role: "parent" | "child" | "single" | "collision";
  parent_sku: string | null;
  child_skus: string[];
  collision: SkuGroupingCollision | null;
  /** Optional for older bridges; when present, contains only real feed SKUs with their stored stock row or null. */
  members?: ProductGroupFamilyMember[];
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
  issue_counts?: { rule: string; label: string; severity: Severity; count: number }[];
}

export interface SeoIssueFilters {
  severity?: Severity;
  status?: SeoIssue["status"];
  rules?: string[];
}

export interface SeoPageFilters {
  page_type?: PageType;
  indexed?: "yes" | "no" | "unchecked";
}

/** Existing index records returned for one SEO page; absent information stays absent in `page`. */
export interface SeoPageBrief {
  page: SeoPage;
  issues: SeoIssue[];
  incoming_links: SeoLink[];
  outgoing_links: SeoLink[];
}

/** A page's stored SEO links and the indexed records for their endpoints; no recommendations are inferred. */
export interface SeoInternalLinkContext {
  page: SeoPage;
  incoming_links: { link: SeoLink; source_page: SeoPage | null }[];
  outgoing_links: { link: SeoLink; target_page: SeoPage | null }[];
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
  /** 已配置且有效的折扣百分比；未配置、未选择或旧台账缺列时为空。 */
  discount_tier?: number | null;
}

export interface SkuImageFilters {
  view?: "in_stock" | "no_feed" | "has_manual" | "none";
  parent_only?: boolean;
}

export interface EdmCommandInput {
  theme: string;
  count: number;
  promo_code?: string;
}

/** Deterministic product-data filters for the EDM candidate pool; no AI ranking or external lookup is implied. */
export interface EdmCandidatesQuery {
  /** Exact normalized category match. */
  category?: string;
  /** Exact normalized tag match. */
  tag?: string;
  /** Defaults to in-stock rows; `any` also includes other stock states. */
  stock?: "in_stock" | "any";
  /** Uses configured SKU grouping; includes parent rows and ungrouped singles when true. */
  parent_only?: boolean;
  /** Defaults to false; when true, rows marked `exclude_edm` are included with that flag visible. */
  include_excluded?: boolean;
  /** Maximum rows returned. `total` remains the count before this limit. */
  limit?: number;
}

/** A factual product row for local EDM planning; it is not an AI-generated recommendation. */
export interface EdmCandidate {
  sku: string;
  title: string;
  category: string | null;
  tags: string[];
  stock_status: StockStatus;
  price: number | null;
  compare_at_price: number | null;
  currency: string | null;
  image_url: string | null;
  image_source: "feed" | "manual" | "none";
  priority: number | null;
  last_featured: ISODate | null;
  exclude_edm: boolean;
  discount_tier: number | null;
}

export interface EdmCandidatesData {
  /** Factual rows are returned in deterministic SKU order; they are not scored or ranked recommendations. */
  rows: EdmCandidate[];
  /** Number of rows matching the filters before `limit` is applied. */
  total: number;
}

/** Filters for the read-only report of products without an EDM-compatible image. */
export interface EdmMediaGapsQuery {
  /** Optional exact set of real SKU or configured parent-row keys. */
  skus?: string[];
  /** Defaults to in-stock rows; `any` also includes other stock states. */
  stock?: "in_stock" | "any";
  /** Uses configured SKU grouping; includes parent rows and ungrouped singles when true. */
  parent_only?: boolean;
  /** Maximum rows returned. `total` remains the count before this limit. */
  limit?: number;
}

export interface EdmMediaGap {
  sku: string;
  title: string;
  stock_status: StockStatus;
  /** `missing` means no indexed image source; `webp_only` means sources exist but none is EDM-compatible. */
  reason: "missing" | "webp_only";
  feed_image_url: string | null;
  manual_image_url: string | null;
}

export interface EdmMediaGapsData {
  rows: EdmMediaGap[];
  /** Number of gaps matching the filters before `limit` is applied. */
  total: number;
}

/** Product selection and campaign date to check against local indexed EDM data; this query never writes or sends. */
export interface EdmCampaignSafetyQuery {
  campaign_date: ISODate;
  /** Selected real feed SKU keys or configured parent-row keys; duplicate entries may be reported as findings. */
  skus: string[];
}

export type EdmCampaignSafetyFindingCode =
  | "duplicate_sku"
  | "sku_not_found"
  | "out_of_stock"
  | "excluded_from_edm"
  | "missing_image"
  | "webp_only"
  | "cooldown_active"
  | "discount_tier_invalid"
  | "currency_mismatch";

export interface EdmCampaignSafetyFinding {
  code: EdmCampaignSafetyFindingCode;
  severity: "blocker" | "warning";
  sku?: string;
  field?: string;
  message: string;
}

/** Local product-data preflight only; it does not inspect email HTML, consent, audience or ESP state. */
export interface EdmCampaignSafetyData {
  scope: "local_product_data";
  /** `clear` requires complete local inputs; incomplete inputs must be represented as `needs_review` plus partial metadata. */
  status: "clear" | "needs_review" | "blocked";
  checked_skus: string[];
  findings: EdmCampaignSafetyFinding[];
}

// ---------- README / 文件夹 / 分类 ----------

export interface ReadmeData {
  user_blocks: { overview: string; focus: string; rules: string };
  auto_blocks: { id: string; title: string; updated_at: ISODateTime | null; schedule: string }[];
  /** @deprecated 2026-10-27 起软件不再管理工作区文件夹（docs/decisions/2026-10-27-data-index-focus.md），待 A/B/C 移除调用后删除。 */
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

export interface ScheduleVerificationDetail {
  job: SchedulableJob;
  state: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ScheduleVerification {
  state: "ok" | "unregistered" | "path_mismatch" | "orphaned" | "error";
  message?: string;
  repaired?: boolean;
  details?: ScheduleVerificationDetail[];
}

export interface SystemTaskRow {
  taskName: string;
  /** null 表示任务未关联到当前登记项目。 */
  projectId: ProjectId | null;
  orphaned: boolean;
  job: SchedulableJob;
  systemState: "Ready" | "Running" | "Disabled";
  lastRunAt: ISODateTime | null;
  lastResult: string | null;
  nextRunAt: ISODateTime | null;
  triggerSummary: string;
  commandPath: string | null;
  /** null 表示孤立任务没有可供比较的项目配置。 */
  configMatches: boolean | null;
  differences: string[];
}

export interface ScheduleRuntimeStatus {
  mode: "system" | "resident";
  authorization_required: boolean;
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
  /** 内置分发已停止；已安装的副本由用户管理，不自动删除。 */
  retired?: boolean;
  reads: string[];
  writes: string[];
}

export interface SkillTargetStatus {
  target_id: string; // "project:kingsyard" | "claude-code" | …
  name: string;
  dir: string | null;
  status: "latest" | "outdated" | "not_installed" | "unknown_path";
  /** 本地版本高于内置版本；安装或同步时不覆盖。 */
  local_newer?: boolean;
}

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "unsupported";
  current: string;
  latest?: string;
  percent?: number;
  notes?: string;
  error?: string;
  manual_url?: string;
}

// ---------- 主接口 ----------

export interface SiteIndexApi {
  updates?: {
    check(): Promise<UpdateStatus>;
    download(): Promise<void>;
    install(): Promise<void>;
    onStatus(cb: (s: UpdateStatus) => void): Unsubscribe;
  };
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
    /** 在不暴露 Webhook 内容的前提下发送一条通知测试消息。 */
    sendTestNotification?(): Promise<void>;
    /** 在系统文件管理器中打开应用日志目录。 */
    openLogs?(): Promise<void>;
  };
  uiState?: {
    get(id: ProjectId): Promise<ProjectUiState>;
    set(id: ProjectId, patch: Partial<ProjectUiState>): Promise<ProjectUiState>;
  };
  /**
   * Project-scoped rule findings and user-maintained review state; optional for older bridges.
   * Re-evaluation preserves status and notes for stable dedupe keys. Only a complete trusted scan can
   * persist absence_confirmed_at; partial/failed scans must retain prior findings and never confirm absence.
   * A later match after confirmed absence moves a done item to pending_review and appends rule_reopened;
   * ignored remains until user change.
   */
  todos?: {
    /** Findings include rule_id and canonical subject identity; scan status prevents gaps looking resolved. */
    list(id: ProjectId): Promise<ProjectTodosResult>;
    /** Updates only explicitly supplied manual fields; note=null clears the note. */
    update(id: ProjectId, input: UpdateTodoManualInput): Promise<TodoManualState>;
    /** Returns append-only manual and rule-reopen events for one stable dedupe key. */
    history(id: ProjectId, dedupeKey: string): Promise<TodoManualHistoryEntry[]>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(id: ProjectId): Promise<ProjectDetail>;
    detect(url: string): Promise<DetectResult>;
    inspectFeed(feedUrls: string[], opts: { sku_field: string; category_depth: number }): Promise<FeedInspectResult>;
    create(input: CreateProjectInput): Promise<{ id: ProjectId; runId: string }>;
    createWorkspaceOnly?(input: CreateWorkspaceOnlyInput): Promise<{ id: ProjectId }>;
    addExisting(path: string): Promise<ProjectSummary>;
    /** 仅取消本机登记，不删除项目目录中的任何文件。 */
    remove?(id: ProjectId): Promise<void>;
    updateConfig(id: ProjectId, patch: Partial<SiteConfig>): Promise<SiteConfig>;
    onChanged(cb: (id: ProjectId) => void): Unsubscribe;
  };
  /** v0.4.0 workspace API；可选以兼容尚未升级的旧 bridge 与 mock。 */
  workspace?: {
    check(targetDir: string): Promise<WorkspaceCheckResult>;
    create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult>;
    importCheck(id: ProjectId, opts?: { apply?: boolean }): Promise<WorkspaceImportCheckResult>;
  };
  overview: {
    get(id: ProjectId): Promise<OverviewData>;
  };
  inventory: {
    summary(id: ProjectId, days?: 14 | HistoryRange): Promise<InventorySummary>;
    listSkus(id: ProjectId, q: ListQuery<SkuStockFilters>): Promise<PageResult<SkuStockView>>;
    dailyReport(id: ProjectId, date: ISODate): Promise<string | null>; // Markdown
    exportCsv(id: ProjectId, q: ListQuery<SkuStockFilters>): Promise<string>; // 保存后的文件路径
  };
  /** v0.2.0 新增能力尚未由 UI / Desktop 实现，保持命名空间可选以兼容旧 bridge 与 mock。 */
  sku?: {
    previewGrouping(id: ProjectId, rule: SkuGroupingRule): Promise<SkuGroupingPreview>;
  };
  products: {
    list(id: ProjectId, q: ListQuery<ProductFilters>): Promise<PageResult<ProductView>>;
    get(id: ProjectId, handle: string): Promise<ProductFull>;
    /** Read-only SKU brief from stored catalog and stock indexes; unavailable source data is described by metadata. */
    skuBrief?(id: ProjectId, sku: string): Promise<ScenarioQueryResult<ProductSkuBrief>>;
    /** Read-only inventory event history for the project, optionally filtered to one SKU; no events is an empty array. */
    changes?(id: ProjectId, sku?: string): Promise<ScenarioQueryResult<ProductChanges>>;
    /** Read-only parent/child relation for one real feed SKU; never creates parent stock. */
    groupFamily?(id: ProjectId, sku: string): Promise<ScenarioQueryResult<ProductGroupFamily>>;
    setTags(id: ProjectId, handle: string, tags: string[]): Promise<string[]>;
    listTags(id: ProjectId): Promise<TagStat[]>;
    createTag(id: ProjectId, tag: string): Promise<TagStat[]>;
    deleteTag(id: ProjectId, tag: string): Promise<TagStat[]>;
    exportCsv(id: ProjectId, q: ListQuery<ProductFilters>): Promise<string>;
  };
  seo: {
    summary(id: ProjectId): Promise<SeoSummary>;
    listIssues(id: ProjectId, q: ListQuery<SeoIssueFilters>): Promise<PageResult<SeoIssue>>;
    /** Read-only indexed page context; absent page records resolve with data=null and metadata describing the gap. */
    pageBrief?(id: ProjectId, url: string): Promise<ScenarioQueryResult<SeoPageBrief>>;
    /** Stored open issues only, optionally narrowed to an exact indexed URL; not a generated or ranked recommendation. */
    issueCandidates?(id: ProjectId, url?: string): Promise<ScenarioQueryResult<SeoIssue[]>>;
    /** Read-only stored inbound/outbound link edges and indexed endpoint pages for one exact URL. */
    internalLinkContext?(id: ProjectId, url: string): Promise<ScenarioQueryResult<SeoInternalLinkContext>>;
    /** 按 URL + 规则键批量更新问题状态；兼容旧 bridge，待 Core/IPC 接入后成为常用方法。 */
    setIssueStatus?(id: ProjectId, input: { targets: { url: string; rule: SeoIssue["rule"] }[]; status: SeoIssue["status"] }): Promise<{ updated: number }>;
    /** 整类规则忽略状态；落盘与下次 weekly 的状态继承由 Core 实现。 */
    setRuleIgnored?(id: ProjectId, rule: SeoIssue["rule"], ignored: boolean): Promise<{ updated: number }>;
    /** 返回 SEO 规则说明、严重级别、待处理数及忽略状态。 */
    getRuleSettings?(id: ProjectId): Promise<SeoRuleSetting[]>;
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
    /** Read-only deterministic candidate facts; metadata reports the indexed sources, collection time, gaps and anomalies. */
    candidates?(id: ProjectId, query: EdmCandidatesQuery): Promise<ScenarioQueryResult<EdmCandidatesData>>;
    /** Read-only report of missing or EDM-incompatible product images; no URLs are fetched by this contract. */
    mediaGaps?(id: ProjectId, query: EdmMediaGapsQuery): Promise<ScenarioQueryResult<EdmMediaGapsData>>;
    /** Read-only local product-data preflight; never schedules, sends, or claims to validate ESP/content safety. */
    campaignSafety?(id: ProjectId, query: EdmCampaignSafetyQuery): Promise<ScenarioQueryResult<EdmCampaignSafetyData>>;
    setManualImage(id: ProjectId, sku: string, url: string | null): Promise<SkuImageRow>;
    /** 按 canonical 导出行键（真实 SKU 或当前规则生成的父 SKU）设置折扣档位，不向父子行传播；仅接受 site.json.edm.discount_tiers 中的百分比，null 清除。旧 bridge 可不提供。 */
    setDiscountTier?(id: ProjectId, sku: string, discountTier: number | null): Promise<{ sku: string; discount_tier: number | null }>;
    buildCommand(id: ProjectId, input: EdmCommandInput): Promise<string>;
    /**
     * 将全项目清单交由 Desktop 原生另存对话框保存；不接收 SKU 子集或 renderer 提供的路径。旧 bridge 可不提供。
     * 新 bridge 只向 renderer 返回 file_name 与统计，不返回绝对路径、文件内容或项目路径；旧 bridge 的 path 字段仅为迁移兼容。
     * 取消选择或覆盖确认时 resolve 为 status="cancelled"，调用方不得显示成功提示。已确认保存才可返回 created/updated/unchanged；
     * 写入状态不确定时返回 EDM_EXPORT_OUTCOME_UNKNOWN，调用方不得将其视为未写入或盲目重试。
     */
    exportIndex?(id: ProjectId): Promise<EdmSkuIndexExportResult>;
  };
  /** WordPress 媒体准备以后台 Job 执行；旧 bridge 可不提供此命名空间。 */
  media?: {
    prepare(input: { project: ProjectId; skus: string[] }): Promise<{ runId: string }>;
  };
  /** GSC authorization and read-only synchronization; optional until Desktop/UI wiring is implemented. */
  gsc?: {
    status(): Promise<GscAuthorizationStatus>;
    connect(): Promise<GscAuthorizationStatus>;
    disconnect(): Promise<GscAuthorizationStatus>;
    /** Read the account's properties and the current project's explicit selection, with source/quality metadata. */
    listProperties(id: ProjectId): Promise<ScenarioQueryResult<GscPropertyListData>>;
    /** Select one property returned by listProperties; null clears the current project's selection. */
    selectProperty(id: ProjectId, siteUrl: string | null): Promise<GscPropertySelection>;
    /** Initial mode imports 90 available days; incremental mode continues from committed history. */
    sync(id: ProjectId, input: GscSyncInput): Promise<GscSyncResult>;
  };
  design: {
    get(id: ProjectId): Promise<{
      tokens: DesignTokens | null;
      screenshots: { name: string; path: string }[];
      /** 由 pathsFor(layout) 解析的项目根目录相对路径；只包含规范文件，不接受任意用户路径。 */
      artifact_paths?: {
        tokens: ProjectPaths["designTokens"];
        brand: ProjectPaths["designBrand"];
      };
    }>;
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
  /** @deprecated 2026-10-27 起软件不再管理工作区文件夹（docs/decisions/2026-10-27-data-index-focus.md），待 A/B/C 移除调用后删除。 */
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
    verify?(id: ProjectId, opts?: { repair?: boolean }): Promise<ScheduleVerification>;
    listOrphans?(): Promise<{ taskName: string; path: string; reason: string }[]>;
    removeOrphan?(taskName: string): Promise<void>;
    listSystemTasks?(): Promise<SystemTaskRow[]>;
    status?(): Promise<ScheduleRuntimeStatus>;
    reauthorize?(): Promise<ScheduleRuntimeStatus>;
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
