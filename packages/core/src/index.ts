/**
 * @siteindex/core — 工作流 A 负责。
 * 纯 Node 逻辑：抓取、库存 diff、视图、SEO、校验、README、台账、Job 编排。
 * 禁止依赖 electron；所有文件路径通过 @siteindex/shared 的 PATHS 获取。
 * 实现清单见 docs/tasks/A-core.md。
 */
import { SCHEMA_VERSION } from "@siteindex/shared";

export const CORE_SCHEMA_VERSION = SCHEMA_VERSION;

/** 与参考实现一致的字符串排序（按 UTF-16 码元 `<` 比较，不用 localeCompare） */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
