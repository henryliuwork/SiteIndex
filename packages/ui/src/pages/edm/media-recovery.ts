import { isValidMediaSkuRecoveryPartition, type MediaPrepareSkuResult, type RunLog } from "@siteindex/shared";

export type MediaRecoveryRowStatus = MediaPrepareSkuResult["status"] | "unknown" | "not_started" | "unavailable";

export interface MediaRecoveryRow {
  sku: string;
  status: MediaRecoveryRowStatus;
  reason?: string;
}

export type MediaRecoveryErrorCode = "WP_AUTH_FAILED" | "WP_FORBIDDEN";

export type MediaRecoveryDisplay =
  | { kind: "legacy"; rows: MediaRecoveryRow[]; errorCode?: MediaRecoveryErrorCode }
  | { kind: "invalid"; rows: MediaRecoveryRow[]; errorCode?: MediaRecoveryErrorCode }
  | {
    kind: "available";
    batchState: "complete" | "interrupted" | "outcome_unknown";
    rows: MediaRecoveryRow[];
    errorCode?: MediaRecoveryErrorCode;
  };

const RECOVERY_FIELDS = [
  "media_requested_skus",
  "media_batch_state",
  "media_results",
  "media_unknown_skus",
  "media_not_started_skus",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function getErrorCode(value: Record<string, unknown>): MediaRecoveryErrorCode | undefined {
  if (value.media_error_code === "WP_AUTH_FAILED" || value.media_error_code === "WP_FORBIDDEN") return value.media_error_code;
  return undefined;
}

function sameSkuOrder(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((sku, index) => sku === expected[index]);
}

/**
 * Converts the shared media recovery partition into explicit UI states.
 * Legacy and malformed records must never be interpreted as "not started".
 */
export function getMediaRecoveryDisplay(value: unknown, expectedSkus?: readonly string[]): MediaRecoveryDisplay {
  if (!isRecord(value)) return { kind: "invalid", rows: [] };

  const errorCode = getErrorCode(value);
  const hasRecoveryMetadata = RECOVERY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
  const requestedSkus = isStringArray(value.media_requested_skus)
    ? [...value.media_requested_skus]
    : expectedSkus ? [...expectedSkus] : [];

  if (!hasRecoveryMetadata) {
    return { kind: "legacy", rows: requestedSkus.map((sku) => ({ sku, status: "unavailable", reason: "旧版任务记录未保存逐 SKU 恢复信息。" })), ...(errorCode ? { errorCode } : {}) };
  }

  if (!isValidMediaSkuRecoveryPartition(value)) {
    return { kind: "invalid", rows: requestedSkus.map((sku) => ({ sku, status: "unavailable", reason: "恢复信息不完整或分区不一致。" })), ...(errorCode ? { errorCode } : {}) };
  }

  if (expectedSkus && !sameSkuOrder(value.media_requested_skus, expectedSkus)) {
    return { kind: "invalid", rows: expectedSkus.map((sku) => ({ sku, status: "unavailable", reason: "恢复结果与本次请求范围不一致。" })), ...(errorCode ? { errorCode } : {}) };
  }

  const results = new Map(value.media_results.map((item) => [item.sku, item]));
  const unknownSkus = new Set(value.media_unknown_skus);
  const notStartedSkus = new Set(value.media_not_started_skus);
  const rows = value.media_requested_skus.map((sku): MediaRecoveryRow => {
    const result = results.get(sku);
    if (result) return { sku, status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
    if (unknownSkus.has(sku)) return { sku, status: "unknown", reason: "无法确认外部处理是否已完成；请先核对图片 URL 与台账。" };
    if (notStartedSkus.has(sku)) return { sku, status: "not_started", reason: "Core 已确认此 SKU 尚未开始处理。" };
    return { sku, status: "unavailable", reason: "恢复分区未覆盖此 SKU。" };
  });

  return {
    kind: "available",
    batchState: value.media_batch_state,
    rows,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function mediaRecoveryErrorMessage(code: MediaRecoveryErrorCode): string {
  return code === "WP_AUTH_FAILED"
    ? "WordPress 认证失败（401），媒体批次已停止。"
    : "WordPress 权限不足（403），媒体批次已停止。";
}

/**
 * Finds selected SKUs whose latest evidenced outcome still needs human review.
 * A later confirmed result resolves an earlier unknown result; a later
 * not-started result does not, because it says nothing about earlier side effects.
 */
export function getMediaRetryReviewSkus(
  history: readonly RunLog[],
  selectedSkus: readonly string[],
  currentRun?: { skus: readonly string[]; result: unknown },
): string[] {
  const latestBySku = new Map<string, MediaRecoveryRowStatus>();

  const record = (value: unknown, expectedSkus?: readonly string[]) => {
    const recovery = getMediaRecoveryDisplay(value, expectedSkus);
    for (const row of recovery.rows) {
      if (row.status === "not_started" || latestBySku.has(row.sku)) continue;
      latestBySku.set(row.sku, row.status);
    }
  };

  if (currentRun) record(currentRun.result, currentRun.skus);

  const mediaHistory = history
    .filter((run) => run.job === "media")
    .map((run, index) => ({ run, index, startedAt: Date.parse(run.started_at) }))
    .sort((left, right) => right.startedAt - left.startedAt || left.index - right.index);

  for (const { run } of mediaHistory) record(run);

  return [...new Set(selectedSkus)].filter((sku) => {
    const status = latestBySku.get(sku);
    return status === "unknown" || status === "unavailable";
  });
}
