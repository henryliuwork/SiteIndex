/**
 * 项目内文件路径常量（相对项目根目录，统一使用正斜杠）。
 * 所有包读写项目文件必须用这里的常量，禁止在代码里手写路径字符串。
 */

export const PATHS = {
  readme: "README.md",
  agentsMd: "AGENTS.md",
  claudeMd: "CLAUDE.md",
  /** @deprecated 2026-10-27 起软件不再管理工作区文件夹（docs/decisions/2026-10-27-data-index-focus.md），待 A/B/C 移除调用后删除。 */
  aboutFile: "_about.md",
  skillsDir: "_agent/skills",
  skillsManifest: "_agent/skills/manifest.json",

  index: "index",
  site: "index/site.json",
  runner: "index/.runner.json",
  lock: "index/.lock",

  robots: "index/site/robots.txt",
  sitemapsSummary: "index/site/sitemaps.json",
  tech: "index/site/tech.json",

  skus: "index/catalog/skus.jsonl",
  productDetails: "index/catalog/product_details.jsonl",
  categories: "index/catalog/categories.json",

  inventoryLatest: "index/inventory/latest.jsonl",
  eventsDir: "index/inventory/events",
  dailySummary: "index/inventory/daily_summary.csv",

  seoPages: "index/seo/pages.jsonl",
  seoIssues: "index/seo/issues.jsonl",
  seoLinks: "index/seo/links.jsonl",

  blogIndex: "index/content/blog_index.jsonl",
  keywords: "index/content/keywords.jsonl",

  skuMedia: "index/ledgers/sku_media.csv",
  skuTags: "index/ledgers/sku_tags.csv",
  edmCampaigns: "index/ledgers/edm_campaigns.jsonl",
  outreach: "index/ledgers/outreach.jsonl",

  designTokens: "index/design/tokens.json",
  designBrand: "index/design/brand.md",
  designScreenshots: "index/design/screenshots",

  productsView: "index/views/products.jsonl",
  skuStockView: "index/views/sku_stock.jsonl",

  dailyReportsDir: "index/reports/daily",
  weeklyReportsDir: "index/reports/weekly",
  archiveDir: "index/archive",

  runs: "index/logs/runs.jsonl",
  validation: "index/logs/validation.json",
  jobLogsDir: "index/logs/jobs",
} as const;

export type PathKey = keyof typeof PATHS;

/** 事件按月分文件 */
export const eventsFile = (yyyyMm: string): string => `${PATHS.eventsDir}/${yyyyMm}.jsonl`;
export const dailyReportFile = (date: string): string => `${PATHS.dailyReportsDir}/${date}.md`;

export const LEDGER_PATHS = {
  keywords: PATHS.keywords,
  sku_media: PATHS.skuMedia,
  sku_tags: PATHS.skuTags,
  edm_campaigns: PATHS.edmCampaigns,
  outreach: PATHS.outreach,
} as const;

/** CSV 表头（固定顺序） */
export const CSV_HEADERS = {
  dailySummary: ["date", "category", "total", "in_stock", "out_of_stock", "preorder", "unknown"],
  skuMedia: ["sku", "image_role", "image_url", "alt_text", "source", "width", "height", "updated_at"],
  skuTags: ["sku", "tags", "priority", "exclude_edm", "email_blurb", "season", "note", "updated_at"],
} as const;

export const DEFAULT_WORKSPACE_FOLDERS = ["seo", "edm", "产品", "内容", "设计", "报告"] as const;

/** 默认云盘冲突副本文件名模式（可在软件设置中追加） */
export const DEFAULT_CONFLICT_PATTERNS: readonly string[] = [
  "冲突",
  "conflict",
  "Conflicted copy",
  "副本",
  "\\(\\d+\\)\\.[a-z]+$",
];
