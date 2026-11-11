import { describe, expect, it } from "vitest";
import {
  API_INVOKE_METHODS,
  CSV_HEADERS,
  EXIT,
  JOB_NAMES,
  PENDING_HANDLERS,
  type InventoryEventType,
  type InventorySummary,
  type JobRequest,
  type JobResult,
  type MediaSkuRecoveryPartition,
  type MediaPrepareSkuResult,
  type RunLog,
  type SiteIndexApi,
  type SiteIndexErrorCode,
  type SkuRecord,
  type SkuMedia,
  isValidMediaSkuRecoveryPartition,
} from "../src";

describe("K5 media and stock contracts", () => {
  it("validates complete, interrupted, and outcome-unknown SKU partitions", () => {
    const complete: MediaSkuRecoveryPartition = {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002"],
      state: "complete",
      results: [
        { sku: "DEMO-WP-001", status: "uploaded" },
        { sku: "DEMO-WP-002", status: "failed", reason: "虚构失败原因。" },
      ],
      unknown_skus: [],
      not_started_skus: [],
    };
    const interrupted: MediaSkuRecoveryPartition = {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003"],
      state: "interrupted",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: [],
      not_started_skus: ["DEMO-WP-002", "DEMO-WP-003"],
    };
    const outcomeUnknown: MediaSkuRecoveryPartition = {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003"],
      state: "outcome_unknown",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: ["DEMO-WP-002"],
      not_started_skus: ["DEMO-WP-003"],
    };

    expect(isValidMediaSkuRecoveryPartition(complete)).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(interrupted)).toBe(true);
    expect(isValidMediaSkuRecoveryPartition(outcomeUnknown)).toBe(true);
  });

  const sparseSkuArray = new Array<string>(1);
  const sparseResultArray = new Array<unknown>(1);

  it.each([
    ["overlap", {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002"],
      state: "outcome_unknown",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: ["DEMO-WP-001"],
      not_started_skus: [],
    }],
    ["missing requested SKU", {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002"],
      state: "interrupted",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["misordered results group", {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003"],
      state: "complete",
      results: [
        { sku: "DEMO-WP-002", status: "uploaded" },
        { sku: "DEMO-WP-001", status: "uploaded" },
        { sku: "DEMO-WP-003", status: "uploaded" },
      ],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["interrupted state with an unknown SKU", {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002"],
      state: "interrupted",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: ["DEMO-WP-002"],
      not_started_skus: [],
    }],
    ["SKU outside the request", {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-002"],
      state: "complete",
      results: [
        { sku: "DEMO-WP-001", status: "uploaded" },
        { sku: "DEMO-WP-999", status: "uploaded" },
      ],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["duplicate requested SKU", {
      requested_skus: ["DEMO-WP-001", "DEMO-WP-001"],
      state: "complete",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: [],
      not_started_skus: [],
    }],
  ] as const)("rejects an invalid %s partition", (_name, partition) => {
    expect(isValidMediaSkuRecoveryPartition(partition)).toBe(false);
  });

  it.each([
    ["null", null],
    ["missing fields", {}],
    ["missing not-started group", {
      requested_skus: ["DEMO-WP-001"],
      state: "complete",
      results: [{ sku: "DEMO-WP-001", status: "uploaded" }],
      unknown_skus: [],
    }],
    ["non-array request", {
      requested_skus: "DEMO-WP-001",
      state: "complete",
      results: [],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["sparse SKU array", {
      requested_skus: sparseSkuArray,
      state: "complete",
      results: [],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["non-string SKU", {
      requested_skus: [1],
      state: "complete",
      results: [],
      unknown_skus: [],
      not_started_skus: [1],
    }],
    ["invalid batch state", {
      requested_skus: ["DEMO-WP-001"],
      state: "garbage",
      results: [],
      unknown_skus: ["DEMO-WP-001"],
      not_started_skus: [],
    }],
    ["invalid result status", {
      requested_skus: ["DEMO-WP-001"],
      state: "complete",
      results: [{ sku: "DEMO-WP-001", status: "maybe_uploaded" }],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["non-object result", {
      requested_skus: ["DEMO-WP-001"],
      state: "complete",
      results: [null],
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["sparse result array", {
      requested_skus: ["DEMO-WP-001"],
      state: "complete",
      results: sparseResultArray,
      unknown_skus: [],
      not_started_skus: [],
    }],
    ["invalid optional result field", {
      requested_skus: ["DEMO-WP-001"],
      state: "complete",
      results: [{ sku: "DEMO-WP-001", status: "uploaded", reason: 1 }],
      unknown_skus: [],
      not_started_skus: [],
    }],
  ] as const)("returns false for malformed persisted data: %s", (_name, value) => {
    expect(isValidMediaSkuRecoveryPartition(value)).toBe(false);
  });

  it("keeps old run logs assignable while making missing recovery data unavailable", () => {
    const oldLog: RunLog = {
      run_id: "demo-old-media-run",
      job: "media",
      started_at: "2026-11-11T10:00:00+08:00",
      finished_at: "2026-11-11T10:01:00+08:00",
      status: "failed",
    };

    expect(oldLog.media_batch_state).toBeUndefined();
    expect(oldLog.media_results).toBeUndefined();
    expect(isValidMediaSkuRecoveryPartition(oldLog)).toBe(false);
  });

  it("keeps the media API additive and models asynchronous per-SKU completion", async () => {
    const legacyApi: Pick<SiteIndexApi, "media"> = {};
    const prepare: NonNullable<SiteIndexApi["media"]>["prepare"] = async ({ project, skus }) => {
      expect(project).toBe("demo-project");
      expect(skus).toEqual(["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003", "DEMO-WP-004", "DEMO-WP-005"]);
      return { runId: "demo-media-run" };
    };
    const request: JobRequest = {
      projectPath: "C:/fixture/demo-project",
      job: "media",
      trigger: "manual",
      skus: ["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003", "DEMO-WP-004", "DEMO-WP-005"],
    };
    const mediaResults: MediaPrepareSkuResult[] = [
      { sku: "DEMO-WP-001", status: "uploaded", image_url: "https://example-shop.test/media/demo-wp-001-main.jpg" },
      { sku: "DEMO-WP-002", status: "reused", image_url: "https://example-shop.test/media/demo-wp-002-main.jpg" },
      { sku: "DEMO-WP-003", status: "recorded", image_url: "https://example-shop.test/images/demo-wp-003-main.jpg" },
      { sku: "DEMO-WP-004", status: "skipped_has_url", image_url: "https://example-shop.test/media/demo-wp-004-main.jpg" },
      { sku: "DEMO-WP-005", status: "failed", reason: "图片来源暂不可用。" },
    ];
    const result: JobResult = {
      runId: "demo-media-run",
      job: "media",
      status: "partial",
      exitCode: EXIT.SOURCE_FAILED,
      summary: "媒体准备部分完成。",
      media_results: mediaResults,
    };

    expect(legacyApi.media).toBeUndefined();
    expect(await prepare({ project: "demo-project", skus: request.skus ?? [] })).toEqual({ runId: "demo-media-run" });
    expect(JOB_NAMES).toContain("media");
    expect(result.media_results).toEqual(mediaResults);
    expect(result.media_results?.map((entry) => entry.sku)).toEqual(request.skus);
    expect(API_INVOKE_METHODS.filter((method) => method === "media.prepare")).toHaveLength(1);
    expect(PENDING_HANDLERS).toContain("media.prepare");
  });

  it.each(["WP_AUTH_FAILED", "WP_FORBIDDEN"] as const)("stops on %s without marking unstarted SKUs", (code) => {
    const requestedSkus = ["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003", "DEMO-WP-004"];
    const result: JobResult = {
      runId: "demo-media-auth-run",
      job: "media",
      status: "partial",
      exitCode: EXIT.SOURCE_FAILED,
      summary: "媒体准备因 WordPress 权限问题提前停止。",
      media_error_code: code,
      errors: ["WordPress 上传权限不足；请检查本机媒体配置。"],
      media_results: [
        { sku: "DEMO-WP-001", status: "uploaded", image_url: "https://example-shop.test/media/demo-wp-001-main.jpg" },
        { sku: "DEMO-WP-002", status: "failed", reason: "WordPress 上传权限不足。" },
      ],
    };

    expect(result.media_error_code).toBe(code);
    expect(result.media_results?.map((entry) => entry.sku)).toEqual(["DEMO-WP-001", "DEMO-WP-002"]);
    expect(result.media_results?.some((entry) => requestedSkus.slice(2).includes(entry.sku))).toBe(false);
    expect(result.media_results).toHaveLength(2);
    expect(result.errors?.join(" ")).not.toMatch(/password|authorization|bearer|wp_app_password/i);
  });

  it("represents cancellation with unresolved SKUs omitted", () => {
    const result: JobResult = {
      runId: "demo-media-cancel-run",
      job: "media",
      status: "failed",
      exitCode: EXIT.GUARD_ABORTED,
      summary: "媒体任务已取消。",
      media_results: [
        { sku: "DEMO-WP-001", status: "uploaded", image_url: "https://example-shop.test/media/demo-wp-001-main.jpg" },
      ],
    };

    expect(result.media_results?.map((entry) => entry.sku)).toEqual(["DEMO-WP-001"]);
    expect(result.exitCode).toBe(EXIT.GUARD_ABORTED);
  });

  it("uses failed when a fatal authorization error occurs before any SKU succeeds", () => {
    const result: JobResult = {
      runId: "demo-media-first-auth-run",
      job: "media",
      status: "failed",
      exitCode: EXIT.SOURCE_FAILED,
      summary: "媒体准备因 WordPress 权限问题提前停止。",
      media_error_code: "WP_AUTH_FAILED",
      media_results: [{ sku: "DEMO-WP-001", status: "failed", reason: "WordPress 上传验证失败。" }],
    };

    expect(result.status).toBe("failed");
    expect(result.media_error_code).toBe("WP_AUTH_FAILED");
    expect(result.media_results).toHaveLength(1);
  });

  it("adds WordPress ledger fields at the tail without requiring them on old rows", () => {
    const oldRow: SkuMedia = {
      sku: "DEMO-OLD-001",
      image_role: "main",
      image_url: "https://example-shop.test/media/old.jpg",
      alt_text: null,
      source: "cdn",
      updated_at: "2026-11-10",
    };
    const wordpressRow: SkuMedia = {
      ...oldRow,
      sku: "DEMO-WP-001",
      source: "wordpress",
      media_id: 123,
      source_hash: "sha256:demo-source-hash",
    };

    expect(oldRow.media_id).toBeUndefined();
    expect(oldRow.source_hash).toBeUndefined();
    expect(wordpressRow).toMatchObject({ source: "wordpress", media_id: 123, source_hash: "sha256:demo-source-hash" });
    expect(CSV_HEADERS.skuMedia).toEqual([
      "sku",
      "image_role",
      "image_url",
      "alt_text",
      "source",
      "width",
      "height",
      "updated_at",
    ]);
    expect(CSV_HEADERS.skuMediaV2).toEqual([...CSV_HEADERS.skuMedia, "media_id", "source_hash"]);
  });

  it("adds removed SKU, anomaly event, and WordPress errors without removing old values", () => {
    const oldEvent: InventoryEventType = "stock_change";
    const anomaly: InventoryEventType = "feed_anomaly";
    const legacyRemovedReason: SkuRecord["removed_reason"] = undefined;
    const removedReason: SkuRecord["removed_reason"] = "feed_absent_404";
    const wordpressErrors: SiteIndexErrorCode[] = [
      "WP_NOT_CONFIGURED",
      "WP_AUTH_FAILED",
      "WP_FORBIDDEN",
      "WP_REST_UNREACHABLE",
      "IMAGE_DECODE_FAILED",
      "IMAGE_FETCH_FAILED",
    ];

    expect(oldEvent).toBe("stock_change");
    expect(anomaly).toBe("feed_anomaly");
    expect(legacyRemovedReason).toBeUndefined();
    expect(removedReason).toBe("feed_absent_404");
    expect(wordpressErrors).toHaveLength(6);
  });

  it("exposes feed anomalies through inventory summary events outside the SEO issue model", () => {
    const eventType: InventorySummary["today"][number]["type"] = "feed_anomaly";
    const event: InventorySummary["today"][number] = {
      type: eventType,
      sku: "DEMO-ANOMALY-001",
      title: "Fictional unavailable feed item",
      detail: "页面有货，但本次完整 feed 未包含此 SKU。",
    };

    expect(event.type).toBe("feed_anomaly");
  });
});
