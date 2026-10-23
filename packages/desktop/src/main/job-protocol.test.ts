import type { AppSettings, JobResult } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { shouldNotify } from "./job-protocol.js";

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
