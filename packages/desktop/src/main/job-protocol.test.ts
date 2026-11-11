import { isValidMediaSkuRecoveryPartition, type AppSettings, type JobResult } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { isJobResult, matchesMediaRecoveryRequest, shouldNotify } from "./job-protocol.js";

const settings: AppSettings = {
  device_id: "test-device",
  device_name: "Test Device",
  projects_root: "",
  extra_projects: [],
  cache_dir: "C:/SiteIndex/cache",
  browser: { channel: "msedge", executable_path: null },
  notify: { on_failure: true, on_success: false, oos_threshold: 0.12, dingtalk_webhook: null },
  skill_platforms: [],
  conflict_patterns: [],
};

function result(job: JobResult["job"], status: JobResult["status"]): JobResult {
  return { runId: "run-1", job, status, exitCode: 0, summary: "已完成。" };
}

describe("job notification policy", () => {
  it("notifies on configured success and failure results", () => {
    expect(shouldNotify(settings, result("daily", "failed"), null)).toBe(true);
    expect(shouldNotify(settings, result("daily", "ok"), null)).toBe(false);
    expect(
      shouldNotify({ ...settings, notify: { ...settings.notify, on_success: true } }, result("daily", "partial"), null),
    ).toBe(true);
  });

  it("uses the configured daily out-of-stock rate threshold", () => {
    expect(shouldNotify(settings, result("daily", "ok"), 0.12)).toBe(true);
    expect(shouldNotify(settings, result("daily", "ok"), 0.119)).toBe(false);
    expect(shouldNotify(settings, result("weekly", "ok"), 0.9)).toBe(false);
    expect(shouldNotify(settings, result("daily", "skipped"), 1)).toBe(false);
  });
});

describe("media Job result protocol", () => {
  const recovery = {
    media_requested_skus: ["fixture-sku-a", "fixture-sku-b"],
    media_batch_state: "outcome_unknown" as const,
    media_results: [{ sku: "fixture-sku-a", status: "uploaded" as const }],
    media_unknown_skus: ["fixture-sku-b"],
    media_not_started_skus: [],
  };

  it("accepts only complete recovery partitions from a media worker", () => {
    const message = {
      runId: "fixture-media-run",
      job: "media",
      status: "partial",
      exitCode: 1,
      summary: "结果不完整",
      ...recovery,
    };

    expect(isValidMediaSkuRecoveryPartition(message)).toBe(true);
    expect(isJobResult(message)).toBe(true);
    expect(isJobResult({ ...message, media_unknown_skus: ["fixture-sku-a"] })).toBe(false);
  });

  it("does not treat an old media result without recovery fields as success data", () => {
    expect(
      isJobResult({
        runId: "fixture-old-media-run",
        job: "media",
        status: "ok",
        exitCode: 0,
        summary: "旧结果",
      }),
    ).toBe(false);
  });

  it("requires the reported requested SKU list to exactly match the deduplicated request in order", () => {
    const partition = (requested: string[]) => ({
      media_requested_skus: requested,
      media_batch_state: "outcome_unknown" as const,
      media_results: [],
      media_unknown_skus: requested,
      media_not_started_skus: [],
    });

    expect(
      matchesMediaRecoveryRequest(partition(["fixture-a", "fixture-b"]), ["fixture-a", "fixture-a", "fixture-b"]),
    ).toBe(true);
    expect(matchesMediaRecoveryRequest(partition(["fixture-a"]), ["fixture-a", "fixture-b"])).toBe(false);
    expect(
      matchesMediaRecoveryRequest(partition(["fixture-a", "fixture-b", "fixture-extra"]), ["fixture-a", "fixture-b"]),
    ).toBe(false);
    expect(matchesMediaRecoveryRequest(partition(["fixture-b", "fixture-a"]), ["fixture-a", "fixture-b"])).toBe(false);
  });
});
