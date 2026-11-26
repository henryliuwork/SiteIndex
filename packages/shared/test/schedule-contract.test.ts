import { describe, expect, it } from "vitest";
import type { ErrorDetail, ScheduleVerification, SiteIndexApi, SystemTaskRow } from "../src";
import { API_INVOKE_METHODS, PENDING_HANDLERS } from "../src";

describe("schedule system task contract", () => {
  it("keeps detailed verification and system task rows optional and typed", () => {
    const verification: ScheduleVerification = {
      state: "path_mismatch",
      details: [
        {
          job: "daily",
          state: "path_mismatch",
          message: "命令路径与项目当前路径不一致",
          expected: "C:\\SiteIndex\\fixture",
          actual: "D:\\SiteIndex\\fixture",
        },
      ],
    };
    const row: SystemTaskRow = {
      taskName: "SiteIndex-fixture-daily",
      projectId: "fixture",
      orphaned: false,
      job: "daily",
      systemState: "Ready",
      lastRunAt: null,
      lastResult: null,
      nextRunAt: "2026-11-06T02:00:00+08:00",
      triggerSummary: "每天 02:00",
      commandPath: "C:\\SiteIndex\\fixture",
      configMatches: true,
      differences: [],
    };
    const legacyApi: Pick<SiteIndexApi["schedule"], "listSystemTasks"> = {};
    const errorDetail: ErrorDetail = {
      code: "SCHEDULE_VERIFY_FAILED",
      operation: "schedule.verify",
      command: ["schtasks.exe", "/Query"],
      exitCode: 1,
      stderr: "系统任务查询失败",
    };
    const failedVerification: ScheduleVerification = {
      state: "error",
      message: "计划任务校验失败",
      error_detail: errorDetail,
    };
    const legacyVerification: ScheduleVerification = { state: "error", message: "计划任务校验失败" };

    expect(verification.details?.[0]).toMatchObject({
      expected: "C:\\SiteIndex\\fixture",
      actual: "D:\\SiteIndex\\fixture",
    });
    expect(row).toMatchObject({ taskName: "SiteIndex-fixture-daily", systemState: "Ready", configMatches: true });
    expect(failedVerification.error_detail).toEqual(errorDetail);
    expect(legacyVerification.error_detail).toBeUndefined();
    expect(legacyApi.listSystemTasks).toBeUndefined();
    expect(API_INVOKE_METHODS.filter((method) => method === "schedule.listSystemTasks")).toHaveLength(1);
    expect(PENDING_HANDLERS).not.toContain("schedule.listSystemTasks");
  });
});
