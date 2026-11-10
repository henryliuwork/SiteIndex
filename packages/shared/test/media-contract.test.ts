import { describe, expect, it } from "vitest";
import {
  API_INVOKE_METHODS,
  CSV_HEADERS,
  EXIT,
  JOB_NAMES,
  PENDING_HANDLERS,
  type InventoryEventType,
  type JobRequest,
  type JobResult,
  type MediaPrepareSkuResult,
  type SiteIndexApi,
  type SiteIndexErrorCode,
  type SkuRecord,
  type SkuMedia,
} from "../src";

describe("K5 media and stock contracts", () => {
  it("keeps the media API additive and models asynchronous per-SKU completion", async () => {
    const legacyApi: Pick<SiteIndexApi, "media"> = {};
    const prepare: NonNullable<SiteIndexApi["media"]>["prepare"] = async ({ project, skus }) => {
      expect(project).toBe("demo-project");
      expect(skus).toEqual(["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003", "DEMO-WP-004"]);
      return { runId: "demo-media-run" };
    };
    const request: JobRequest = {
      projectPath: "C:/fixture/demo-project",
      job: "media",
      trigger: "manual",
      skus: ["DEMO-WP-001", "DEMO-WP-002", "DEMO-WP-003", "DEMO-WP-004"],
    };
    const mediaResults: MediaPrepareSkuResult[] = [
      { sku: "DEMO-WP-001", status: "uploaded", image_url: "https://example-shop.test/media/demo-wp-001-main.jpg" },
      { sku: "DEMO-WP-002", status: "reused", image_url: "https://example-shop.test/media/demo-wp-002-main.jpg" },
      { sku: "DEMO-WP-003", status: "skipped_has_url", image_url: "https://example-shop.test/media/demo-wp-003-main.jpg" },
      { sku: "DEMO-WP-004", status: "failed", reason: "图片来源暂不可用。" },
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
});
