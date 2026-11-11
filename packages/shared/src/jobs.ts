import type { SiteIndexErrorCode } from "./errors";
import type { JobName, MediaBatchState, MediaPrepareSkuResult } from "./models";

export const JOB_NAMES: readonly JobName[] = [
  "daily",
  "weekly",
  "monthly",
  "validate",
  "readme",
  "design",
  "index-check",
  "views",
  "init",
  "media",
];

/** 新建项目流程的进度步骤，由 Core 执行除 schedule 外的步骤。 */
export const INIT_STEPS = ["folders", "config", "readme", "skills", "daily", "weekly", "views", "schedule"] as const;
export type InitStepKey = (typeof INIT_STEPS)[number];

/** 定时计划可配置的任务 */
export const SCHEDULABLE_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type SchedulableJob = (typeof SCHEDULABLE_JOBS)[number];

export type JobTrigger = "schedule" | "manual" | "cli";

export interface JobRequest {
  projectPath: string;
  job: JobName;
  trigger: JobTrigger;
  /** 只执行某个步骤，如 weekly 的 "links"（用于"重新生成"单个文件） */
  only?: string;
  /** 指定业务日期（测试用） */
  date?: string;
  force?: boolean;
  dryRun?: boolean;
  /** media Job 选择处理的 SKU；其他 Job 忽略此字段。 */
  skus?: string[];
}

export type JobLogLevel = "info" | "warn" | "error";

export interface JobProgress {
  runId: string;
  projectPath: string;
  job: JobName;
  /** 0–100；未知时为 null */
  pct: number | null;
  /** init 任务使用 INIT_STEPS 中的 key；其他任务使用各自的步骤名。 */
  step?: string;
  level: JobLogLevel;
  message: string;
  at: string;
}

export interface JobResult {
  runId: string;
  job: JobName;
  status: "ok" | "partial" | "failed" | "skipped";
  exitCode: number;
  summary: string;
  counts?: Record<string, number>;
  errors?: string[];
  /** init 任务逐步结果；schedule 由 Desktop 执行。 */
  steps?: { key: string; status: "ok" | "failed" | "skipped"; message?: string }[];
  /**
   * media 的完整请求列表，按去重后的请求顺序返回；旧 bridge 可不提供。
   * 新实现必须同时返回 media_batch_state、media_results、media_unknown_skus 和 media_not_started_skus，
   * 且后三项按 SKU 将请求列表无重叠地完整分区。旧结果缺少这些字段时表示不可恢复，不能按空结果处理。
   * complete 表示所有 SKU 都有已确认结果；interrupted 表示未完成项可确认未开始；outcome_unknown 表示存在结果不确定项。
   */
  media_requested_skus?: string[];
  media_batch_state?: MediaBatchState;
  media_results?: MediaPrepareSkuResult[];
  /** 无法确认是否已开始处理或外部副作用结果的 SKU；硬退出时宁可标未知，也不可误报失败或未开始。 */
  media_unknown_skus?: string[];
  /** 已确认没有开始处理的 SKU。 */
  media_not_started_skus?: string[];
  /** media 因 WordPress 认证失败或权限不足停批时，返回 WP_AUTH_FAILED / WP_FORBIDDEN。 */
  media_error_code?: Extract<SiteIndexErrorCode, "WP_AUTH_FAILED" | "WP_FORBIDDEN">;
}

export interface MediaSkuRecoveryPartition {
  media_requested_skus: readonly string[];
  media_batch_state: MediaBatchState;
  media_results: readonly MediaPrepareSkuResult[];
  media_unknown_skus: readonly string[];
  media_not_started_skus: readonly string[];
}

const MEDIA_BATCH_STATES = ["complete", "interrupted", "outcome_unknown"] as const;
const MEDIA_PREPARE_STATUSES = ["uploaded", "reused", "recorded", "skipped_has_url", "failed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== "string") return false;
  }
  return true;
}

function isMediaPrepareResult(value: unknown): value is MediaPrepareSkuResult {
  if (!isRecord(value)) return false;
  const { sku, status, reason, image_url } = value;
  return typeof sku === "string"
    && MEDIA_PREPARE_STATUSES.some((allowed) => allowed === status)
    && (reason === undefined || typeof reason === "string")
    && (image_url === undefined || typeof image_url === "string");
}

function isMediaPrepareResultArray(value: unknown): value is MediaPrepareSkuResult[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !isMediaPrepareResult(value[index])) return false;
  }
  return true;
}

/**
 * 直接校验 JobResult / RunLog 上的 media_* 字段；旧记录缺少任一必需字段时返回 false。
 * 只验证结构和分区，不验证外部副作用真实性，也不证明 reason/image_url 已脱敏。
 */
export function isValidMediaSkuRecoveryPartition(value: unknown): value is MediaSkuRecoveryPartition {
  try {
    if (!isRecord(value)) return false;
    const {
      media_requested_skus: requested_skus,
      media_batch_state: state,
      media_results: results,
      media_unknown_skus: unknown_skus,
      media_not_started_skus: not_started_skus,
    } = value;
    if (!isStringArray(requested_skus) || !isStringArray(unknown_skus) || !isStringArray(not_started_skus)) return false;
    if (!isMediaPrepareResultArray(results) || !MEDIA_BATCH_STATES.some((allowed) => allowed === state)) return false;

    const requested = new Set(requested_skus);
    if (requested.size !== requested_skus.length) return false;

    const resultSkus = results.map(({ sku }) => sku);
    const assignedSkus = [...resultSkus, ...unknown_skus, ...not_started_skus];
    if (assignedSkus.length !== requested_skus.length || new Set(assignedSkus).size !== assignedSkus.length) return false;
    if (assignedSkus.some((sku) => !requested.has(sku))) return false;

    const requestOrder = new Map(requested_skus.map((sku, index) => [sku, index]));
    const preservesRequestOrder = (skus: readonly string[]): boolean => {
      let previous = -1;
      for (const sku of skus) {
        const current = requestOrder.get(sku);
        if (current === undefined || current <= previous) return false;
        previous = current;
      }
      return true;
    };
    if (!preservesRequestOrder(resultSkus) || !preservesRequestOrder(unknown_skus) || !preservesRequestOrder(not_started_skus)) {
      return false;
    }

    if (state === "complete") return unknown_skus.length === 0 && not_started_skus.length === 0;
    if (state === "interrupted") return unknown_skus.length === 0 && not_started_skus.length > 0;
    if (state === "outcome_unknown") return unknown_skus.length > 0;
    return false;
  } catch {
    return false;
  }
}

/** 进度回调：core 的每个 Job 接收它；desktop 转发为 IPC 事件，cli 打印到终端 */
export type ProgressReporter = (p: Omit<JobProgress, "runId" | "projectPath" | "job" | "at">) => void;
