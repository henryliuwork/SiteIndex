/** 命令行契约：命令名与 query 目标。cli（工作流 A）实现，skills 与 desktop 引用。详见 docs/ARCHITECTURE.md §6 */

export const CLI_BIN = "siteindex";

export const CLI_COMMANDS = [
  "detect",
  "init",
  "feed",
  "run",
  "validate",
  "views",
  "query",
  "ledger",
  "edm",
  "categories",
  "folders",
  "schedule",
  "runner",
  "skills",
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

export const QUERY_TARGETS = ["products", "sku-stock", "seo-pages", "seo-issues", "blog", "keywords", "sku-media"] as const;
export type QueryTarget = (typeof QUERY_TARGETS)[number];

export const WRITABLE_LEDGERS = ["keywords", "sku_media", "sku_tags", "edm_campaigns", "outreach"] as const;
export type WritableLedger = (typeof WRITABLE_LEDGERS)[number];

/** 定时模式参数：SiteIndex.exe --run-job "<projectPath>" <job> */
export const RUN_JOB_FLAG = "--run-job";

/** `--json` 输出的统一外壳 */
export interface CliJsonOutput<T = unknown> {
  ok: boolean;
  exit_code: number;
  data?: T;
  error?: { code: string; message: string };
}
