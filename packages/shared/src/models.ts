/**
 * 数据模型：与 docs/DATA_SPEC.md、schemas/*.schema.json 一一对应。
 * 字段名保持 snake_case（与磁盘上的 JSON 完全一致），不要转换为 camelCase。
 * 修改需走契约流程（见 docs/WORKSTREAMS.md §4）。
 */

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // ISO 8601 带时区
export type Url = string;

export const SCHEMA_VERSION = "1.1" as const;

// ---------- 配置 ----------

export type Platform = "magento" | "wordpress" | "woocommerce" | "shopify" | "other";
export type CategoryMode = "url_rule" | "feed" | "manual";
export type CategoryMatchType = "product_type_contains" | "sku_prefix" | "url_contains" | "skus";
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // 1 = 周一 … 7 = 周日

export interface ManualCategory {
  slug: string;
  name: string;
  url: string;
  match: { type: CategoryMatchType; value: string }[];
}

export interface JobSchedule {
  enabled: boolean;
  days?: Weekday[];
  day_of_month?: number;
  time: string; // "HH:mm"
}

export interface ScheduleConfig {
  daily: JobSchedule;
  validate: JobSchedule;
  weekly: JobSchedule;
  readme: JobSchedule;
  monthly: JobSchedule;
  options: {
    wake_to_run: boolean;
    run_if_missed: boolean;
    notify_on_failure: boolean;
    validate_after_sync: boolean;
  };
}

export interface WorkspaceFolder {
  name: string;
  default: boolean;
}

export interface SiteConfig {
  schema_version: string;
  domain: string;
  base_url: Url;
  platform: Platform;
  currency: string;
  locale: string;
  timezone: string;
  markets?: string[];
  brand: { name: string; tagline?: string; voice?: string; audience?: string; usp?: string[] };
  sitemaps: Url[];
  crawl: {
    adapter: "gmc_feed";
    feed_url: Url | Url[];
    sku_field?: string;
    category_depth?: number;
    missing_as?: "out_of_stock" | "removed";
    missing_removed_after_days?: number;
    max_removed_ratio?: number;
    feed_generated_at?: string;
    blog_url_patterns?: string[];
    exclude_url_patterns?: string[];
    max_pages?: number;
    crawl_product_pages?: boolean;
    rate_limit_ms: number;
    user_agent?: string;
    overrides?: Record<string, Record<string, unknown>>;
  };
  categories: { mode: CategoryMode; url_pattern?: string; manual?: ManualCategory[] };
  seo?: {
    core_keywords?: string[];
    competitors?: string[];
    title_range?: [number, number];
    description_range?: [number, number];
    ignore_rules?: { url: string; rule: SeoRule }[];
  };
  edm?: {
    platform?: "mailchimp" | "wordpress" | "other";
    max_products?: number;
    cooldown_days?: number;
    utm?: { source?: string; medium?: string };
    image_priority?: ("feed" | "manual")[];
  };
  /** @deprecated 2026-10-27 起软件不再管理工作区文件夹（docs/decisions/2026-10-27-data-index-focus.md），待 A/B/C 移除调用后删除。 */
  workspace_folders: WorkspaceFolder[];
  schedule: ScheduleConfig;
  integrations?: {
    linkflow?: { mcp_server?: string; create_tool?: string; project?: string };
    sales?: Record<string, unknown>;
    gsc?: Record<string, unknown>;
    mailchimp?: Record<string, unknown>;
  };
  readme?: { disabled_blocks?: ReadmeBlockId[] };
}

export interface RunnerInfo {
  device_id: string;
  device_name: string;
  claimed_at: ISODateTime;
}

export interface LockInfo extends Omit<RunnerInfo, "claimed_at"> {
  pid: number;
  job: JobName;
  started_at: ISODateTime;
  heartbeat: ISODateTime;
}

// ---------- 商品目录 ----------

export type CategorySource = "url_rule" | "feed" | "manual" | "none";

export interface SkuRecord {
  sku: string;
  product_id: string;
  handle: string;
  title: string;
  variant_title: string | null;
  url: Url;
  category: string;
  categories?: string[];
  category_source: CategorySource;
  price: number;
  compare_at_price: number | null;
  currency: string;
  image_url: Url | null;
  additional_images?: Url[];
  gtin?: string | null;
  mpn?: string | null;
  brand?: string | null;
  status: "active" | "removed";
  first_seen: ISODate;
  last_seen: ISODate;
  updated_at: ISODate;
}

export interface ProductDetails {
  handle: string;
  short_description: string | null;
  rating: number | null;
  review_count: number | null;
  breadcrumbs: string[];
  gallery: Url[];
  related_handles: string[];
  badges: string[];
  shipping_note: string | null;
  last_crawled: ISODate;
}

export interface Category {
  slug: string;
  name: string;
  url: string;
  parent: string | null;
  source: CategorySource;
  product_count?: number;
  sku_count?: number;
  in_stock_count?: number;
  intro_text_words?: number | null;
  last_seen: ISODate;
}

// ---------- 库存 ----------

export type StockStatus = "in_stock" | "out_of_stock" | "preorder" | "unknown";

export interface InventoryLatest {
  sku: string;
  stock_status: StockStatus;
  qty: number | null;
  since: ISODate;
  checked_at: ISODateTime;
}

export type InventoryEventType = "stock_change" | "price_change" | "new_sku" | "removed_sku" | "restored_sku";

export interface InventoryEvent {
  date: ISODate;
  sku: string;
  type: InventoryEventType;
  from: unknown;
  to: unknown;
  category: string;
  title: string;
}

export interface DailySummaryRow {
  date: ISODate;
  category: string; // "_all" = 全站
  total: number;
  in_stock: number;
  out_of_stock: number;
  preorder: number;
  unknown: number;
}

// ---------- SEO ----------

export type PageType = "home" | "collection" | "product" | "blog" | "page" | "other";

export type SeoRule =
  | "http_4xx"
  | "http_5xx"
  | "redirect_chain"
  | "noindex"
  | "canonical_other"
  | "canonical_missing"
  | "not_in_sitemap"
  | "title_missing"
  | "desc_missing"
  | "title_length"
  | "desc_length"
  | "title_duplicate"
  | "desc_duplicate"
  | "h1_missing"
  | "h1_multiple"
  | "schema_missing"
  | "schema_error"
  | "img_alt_missing"
  | "thin_content"
  | "orphan";

export interface SeoPage {
  url: Url;
  page_type: PageType;
  status_code: number;
  final_url?: Url | null;
  redirect_chain?: Url[];
  response_ms?: number | null;
  title: string | null;
  title_length: number;
  meta_description: string | null;
  description_length: number;
  meta_keywords?: string | null;
  h1: string | null;
  h1_count: number;
  h2?: string[];
  canonical: Url | null;
  canonical_status: "self" | "other" | "missing";
  robots_meta: string | null;
  x_robots_tag: string | null;
  indexable: boolean;
  in_sitemap: boolean;
  google_indexed?: boolean | null;
  index_checked_at?: ISODate | null;
  hreflang?: { lang: string; url: Url }[];
  og?: { title?: string | null; description?: string | null; image?: Url | null };
  twitter_card?: string | null;
  schema_types: string[];
  schema_errors?: string[];
  word_count: number | null;
  images_total?: number;
  images_missing_alt?: number;
  links_internal_out?: number;
  links_external_out?: number;
  links_internal_in?: number;
  last_crawled: ISODate;
}

export type Severity = "high" | "mid" | "low";

export interface SeoIssue {
  url: Url;
  rule: SeoRule;
  severity: Severity;
  detail: string;
  status: "open" | "fixed" | "ignored";
  first_seen: ISODate;
  last_seen: ISODate;
}

export interface SeoLink {
  from: Url;
  to: Url;
  anchor: string;
  to_type: "product" | "collection" | "blog" | "page";
  nofollow?: boolean;
}

// ---------- 内容 ----------

export interface BlogPost {
  url: Url;
  slug: string;
  title: string;
  published_at: ISODate;
  updated_at: ISODate | null;
  category: string | null;
  author: string | null;
  tags: string[];
  meta_description: string | null;
  word_count: number | null;
  reading_minutes?: number | null;
  outline?: string[];
  has_faq?: boolean;
  featured_image?: Url | null;
  primary_keyword?: string | null;
  links_internal: Url[];
  links_products: string[];
  links_in?: number;
  linked_out_of_stock?: string[];
  last_crawled: ISODate;
}

export interface Keyword {
  keyword: string;
  target_url: Url | null;
  role: "primary" | "secondary";
  intent: "informational" | "commercial" | "transactional" | "navigational";
  cluster: string;
  status: "planned" | "drafting" | "live";
  priority?: number | null;
  source?: string | null;
  note?: string | null;
  search_volume?: number | null; // 预留
  difficulty?: number | null; // 预留
  current_rank?: number | null; // 预留
  rank_checked_at?: ISODate | null; // 预留
  updated_at: ISODate;
}

// ---------- 台账 ----------

export interface SkuMedia {
  sku: string;
  image_role: "main" | "alt" | "lifestyle";
  image_url: Url;
  alt_text: string | null;
  source: "mailchimp" | "cdn";
  width?: number | null;
  height?: number | null;
  updated_at: ISODate;
}

export interface SkuTags {
  sku: string;
  tags: string | null; // 小写，";" 分隔
  priority: number | null;
  exclude_edm: 0 | 1 | null;
  email_blurb?: string | null;
  season?: string | null;
  note: string | null;
  updated_at: ISODate;
}

export interface EdmCampaign {
  campaign_id: string;
  date: ISODate;
  theme: string;
  status: "draft" | "scheduled" | "sent";
  subject?: string | null;
  preheader?: string | null;
  audience?: string | null;
  handles: string[];
  promo_code?: string | null;
  utm_campaign?: string | null;
  mailchimp_campaign_id?: string | null;
  send_date?: ISODate | null;
  recipients?: number | null; // 预留
  open_rate?: number | null; // 预留
  click_rate?: number | null; // 预留
  orders?: number | null; // 预留
  revenue?: number | null; // 预留
}

export interface OutreachContact {
  domain: string;
  added_at: ISODate;
  status: "pushed" | "contacted" | "replied" | "partnered" | "rejected" | "invalid";
  linkflow_id?: string | null;
  topic?: string | null;
  note?: string | null;
  target_url?: Url | null;
  live_link?: Url | null;
}

export type LedgerName = "keywords" | "sku_media" | "sku_tags" | "edm_campaigns" | "outreach";

// ---------- 视图 ----------

export interface ProductView {
  handle: string;
  product_id: string;
  title: string;
  url: Url;
  category: string;
  categories: string[];
  price_min: number | null;
  price_max: number | null;
  compare_at_max: number | null;
  currency: string;
  on_sale: boolean;
  image_url: Url | null;
  image_source: "feed" | "manual" | "none";
  feed_image_url: Url | null;
  manual_image_url: Url | null;
  variant_count: number;
  skus: string[];
  in_stock_variants: number;
  stock_status: StockStatus;
  stock_since: ISODate | null;
  tags: string[];
  priority: number | null;
  exclude_edm: 0 | 1;
  email_blurb?: string | null;
  last_featured: ISODate | null;
  days_since_featured: number | null;
  is_new?: boolean;
  restocked_at?: ISODate | null;
  price_dropped_at?: ISODate | null;
  short_description?: string | null;
  rating?: number | null;
  review_count?: number | null;
  seo_issue_count?: number;
  units_30d?: number | null; // 预留
  revenue_30d?: number | null; // 预留
  sales_rank?: number | null; // 预留
  first_seen: ISODate;
  status: "active" | "removed";
}

/** history_30d：30 个字符，最旧在左：i 有货 / o 缺货 / p 预售 / u 未知 / - 未上架 */
export type DayState = "i" | "o" | "p" | "u" | "-";

export interface SkuStockView {
  sku: string;
  title: string;
  variant_title: string | null;
  category: string;
  price: number;
  stock_status: StockStatus;
  since: ISODate;
  days_in_status: number;
  online_rate_7d: number | null;
  online_rate_30d: number | null;
  history_30d: string;
  changes_30d: number;
  last_change: string | null;
  last_change_at: ISODate | null;
}

// ---------- 日志与校验 ----------

export type JobName = "daily" | "weekly" | "monthly" | "validate" | "readme" | "design" | "index-check" | "views" | "init";

export interface RunLogStep {
  key: string;
  status: "ok" | "failed" | "skipped";
  message?: string;
}

export interface RunLog {
  run_id: string;
  job: JobName;
  trigger?: "schedule" | "manual" | "cli";
  device_name?: string;
  started_at: ISODateTime;
  finished_at: ISODateTime | null;
  status: "ok" | "partial" | "failed" | "skipped";
  counts?: Record<string, number>;
  errors?: string[];
  steps?: RunLogStep[];
}

export type FileKind = "sync" | "ledger" | "config" | "view" | "doc";
export type FileStatus = "ok" | "error" | "missing" | "conflict_copy";
export type ValidationRule =
  | "missing"
  | "parse"
  | "schema"
  | "header"
  | "pk_duplicate"
  | "sort"
  | "ref"
  | "conflict_copy"
  | "stale"
  | "readme_markers";
/** regenerate:{job}[.{step}] | autofix | restore_archive | delete_copy */
export type RepairAction = `regenerate:${string}` | "autofix" | "restore_archive" | "delete_copy";

export interface FileCheck {
  path: string; // 相对项目根目录，正斜杠
  kind: FileKind;
  status: FileStatus;
  rule?: ValidationRule | null;
  message?: string | null;
  line?: number | null;
  records?: number | null;
  size?: number | null;
  modified_at?: ISODateTime | null;
  repair?: RepairAction | null;
}

export interface ValidationReport {
  checked_at: ISODateTime;
  trigger: "schedule" | "manual" | "after_sync" | "cli";
  summary: { total: number; ok: number; error: number; missing: number; conflict_copy: number };
  files: FileCheck[];
}

// ---------- 设计规范 ----------

export interface DesignTokens {
  extracted_at: ISODateTime;
  source_pages: Url[];
  css_variables: Record<string, string>;
  color: {
    primary: string | null;
    secondary?: string | null;
    text: string | null;
    text_muted?: string | null;
    background: string | null;
    surface?: string | null;
    border?: string | null;
    sale?: string | null;
    palette: { value: string; count: number }[];
  };
  typography: {
    font_families: { heading?: string; body?: string };
    scale: Record<string, { size: string; weight: number; line_height: string }>;
  };
  spacing: string[];
  radius: string[];
  shadow: string[];
  components: Record<string, Record<string, string | number>>;
  assets: { logo?: Url | null; favicon?: Url | null };
  email_safe?: { font_stack?: string; button_color?: string };
}

// ---------- README ----------

export type ReadmeBlockId = "index-summary" | "folder-map" | "task-routing" | "data-guide" | "design-summary" | "changelog";
