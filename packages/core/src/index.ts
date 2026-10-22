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
export { assertRunner, CoreIOError, findConflictCopies, isConflictCopy, readRunner, withLock, writeRunner } from "./io/runner-lock";

export const CORE_SCHEMA_VERSION = SCHEMA_VERSION;
