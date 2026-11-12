import { describe, expect, it } from "vitest";
import type { RunLog } from "@siteindex/shared";
import { getMediaRecoveryDisplay, getMediaRetryReviewSkus, mediaRecoveryErrorMessage } from "./media-recovery";

describe("getMediaRecoveryDisplay", () => {
  it("旧历史缺少恢复字段时标为不可恢复，不把 SKU 误报为未开始", () => {
    const display = getMediaRecoveryDisplay({ job: "media", status: "failed" }, ["DEMO-A", "DEMO-B"]);

    expect(display.kind).toBe("legacy");
    expect(display.rows.map((row) => row.status)).toEqual(["unavailable", "unavailable"]);
  });

  it("按契约恢复已确认、结果未知与已确认未开始的互斥状态", () => {
    const display = getMediaRecoveryDisplay({
      media_requested_skus: ["DEMO-A", "DEMO-B", "DEMO-C"],
      media_batch_state: "outcome_unknown",
      media_results: [{ sku: "DEMO-A", status: "uploaded" }],
      media_unknown_skus: ["DEMO-B"],
      media_not_started_skus: ["DEMO-C"],
    });

    expect(display.kind).toBe("available");
    if (display.kind !== "available") return;
    expect(display.batchState).toBe("outcome_unknown");
    expect(display.rows.map(({ status }) => status)).toEqual(["uploaded", "unknown", "not_started"]);
  });

  it("分区不完整时整体标为不可确认，不猜测缺失 SKU 状态", () => {
    const display = getMediaRecoveryDisplay({
      media_requested_skus: ["DEMO-A", "DEMO-B"],
      media_batch_state: "interrupted",
      media_results: [{ sku: "DEMO-A", status: "uploaded" }],
    });

    expect(display.kind).toBe("invalid");
    expect(display.rows.map((row) => row.status)).toEqual(["unavailable", "unavailable"]);
  });

  it("请求 SKU 顺序与恢复记录不一致时拒绝套用结果", () => {
    const display = getMediaRecoveryDisplay({
      media_requested_skus: ["DEMO-A", "DEMO-B"],
      media_batch_state: "interrupted",
      media_results: [{ sku: "DEMO-A", status: "uploaded" }],
      media_unknown_skus: [],
      media_not_started_skus: ["DEMO-B"],
    }, ["DEMO-B", "DEMO-A"]);

    expect(display.kind).toBe("invalid");
    expect(display.rows.every((row) => row.status === "unavailable")).toBe(true);
  });

  it.each([
    ["WP_AUTH_FAILED", "WordPress 认证失败（401），媒体批次已停止。"],
    ["WP_FORBIDDEN", "WordPress 权限不足（403），媒体批次已停止。"],
  ] as const)("仅按 %s 契约码展示认证终止", (code, message) => {
    const display = getMediaRecoveryDisplay({ job: "media", media_error_code: code });
    expect(display.errorCode).toBe(code);
    expect(mediaRecoveryErrorMessage(code)).toBe(message);
  });

  it("不会从自由文本错误推断 401 或 403", () => {
    const display = getMediaRecoveryDisplay({ job: "media", errors: ["HTTP 403"] });
    expect(display.errorCode).toBeUndefined();
  });
});

describe("getMediaRetryReviewSkus", () => {
  it("为所选结果未知的 SKU 要求复核，不阻塞已确认未开始的 SKU", () => {
    const history: RunLog[] = [{
      run_id: "demo-unknown-run",
      job: "media",
      started_at: "2026-11-10T10:00:00.000Z",
      finished_at: "2026-11-10T10:01:00.000Z",
      status: "partial",
      media_requested_skus: ["DEMO-UNKNOWN", "DEMO-NOT-STARTED"],
      media_batch_state: "outcome_unknown",
      media_results: [],
      media_unknown_skus: ["DEMO-UNKNOWN"],
      media_not_started_skus: ["DEMO-NOT-STARTED"],
    }];

    expect(getMediaRetryReviewSkus(history, ["DEMO-UNKNOWN", "DEMO-NOT-STARTED"])).toEqual(["DEMO-UNKNOWN"]);
  });

  it("较新的确认结果解除旧未知项，较新的未开始结果则不会解除", () => {
    const unknownRun: RunLog = {
      run_id: "demo-unknown-run",
      job: "media",
      started_at: "2026-11-10T10:00:00.000Z",
      finished_at: "2026-11-10T10:01:00.000Z",
      status: "partial",
      media_requested_skus: ["DEMO-A"],
      media_batch_state: "outcome_unknown",
      media_results: [],
      media_unknown_skus: ["DEMO-A"],
      media_not_started_skus: [],
    };
    const confirmedRun: RunLog = {
      run_id: "demo-confirmed-run",
      job: "media",
      started_at: "2026-11-11T10:00:00.000Z",
      finished_at: "2026-11-11T10:01:00.000Z",
      status: "ok",
      media_requested_skus: ["DEMO-A"],
      media_batch_state: "complete",
      media_results: [{ sku: "DEMO-A", status: "skipped_has_url" }],
      media_unknown_skus: [],
      media_not_started_skus: [],
    };
    const notStartedRun: RunLog = {
      ...confirmedRun,
      run_id: "demo-not-started-run",
      media_batch_state: "interrupted",
      media_results: [],
      media_not_started_skus: ["DEMO-A"],
    };

    expect(getMediaRetryReviewSkus([unknownRun, confirmedRun], ["DEMO-A"])).toEqual([]);
    expect(getMediaRetryReviewSkus([unknownRun, notStartedRun], ["DEMO-A"])).toEqual(["DEMO-A"]);
  });
});
