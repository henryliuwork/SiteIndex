/**
 * @siteindex/core — 工作流 A 负责。
 * 纯 Node 逻辑：抓取、库存 diff、视图、SEO、校验、README、台账、Job 编排。
 * 禁止依赖 electron；所有文件路径通过 @siteindex/shared 的 PATHS 获取。
 * 实现清单见 docs/tasks/A-core.md。
 */
import { SCHEMA_VERSION } from "@siteindex/shared";
export { atomicWrite } from "./io/atomic-write";
export { readCsv, writeCsv } from "./io/csv";
export { compareKeys } from "./io/compare";
export { readJsonl, writeJsonl } from "./io/jsonl";
export { renderEdm } from "./edm-render";
export type { EdmRenderOptions, EdmRenderResult } from "./edm-render";
export {
  buildReadmeAutoContent,
  parseReadmeAutoBlocks,
  README_AUTO_BLOCK_TITLES,
  replaceReadmeAutoBlocks,
} from "./readme";
export type { ReadmeAutoBlockId, ReadmeAutoContent, ReadmeAutoContentInput } from "./readme";
export { deleteLedger, upsertLedger } from "./ledger";
export type { LedgerKey, LedgerMutationOptions, LedgerMutationResult, LedgerName } from "./ledger";
export { assertRunner, CoreIOError, findConflictCopies, isConflictCopy, readRunner, withLock, writeRunner } from "./io/runner-lock";
export { applyFeedOverrides, FeedError, parseFeed, readFeeds, toSnapshot, writeSnapshot } from "./crawl/gmc-feed";
export type { FeedItem, FeedSiteConfig, FeedSnapshot, SnapshotResult, StockStatus } from "./crawl/gmc-feed";
export { runDaily, runDailyFromFile } from "./jobs/daily";
export type { DailyOptions, DailyResult, DailySnapshot } from "./jobs/daily";
export { buildViews } from "./views/build";
export type { BuildViewsOptions, BuildViewsResult } from "./views/build";
export { createCoreService } from "./service";
export type { CoreService, CoreServiceContext } from "./service";

export const CORE_SCHEMA_VERSION = SCHEMA_VERSION;
