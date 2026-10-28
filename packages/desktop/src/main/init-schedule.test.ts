import { EXIT, type JobProgress, type JobResult } from "@siteindex/shared";
import { describe, expect, it, vi } from "vitest";
import { completeInitSchedule } from "./init-schedule.js";

const projectPath = "C:/SiteIndex/projects/example";
const coreResult: JobResult = {
  runId: "2026-10-28-init-desktop",
  job: "init",
  status: "ok",
  exitCode: EXIT.OK,
  summary: "项目初始化完成。",
  steps: [
    { key: "daily", status: "ok" },
    { key: "schedule", status: "skipped", message: "由桌面端注册" },
  ],
};

describe("init schedule finalization", () => {
  it("replaces Core's placeholder and emits schedule progress before completion", async () => {
    const progress: JobProgress[] = [];
    const register = vi.fn(async () => ({
      enabled: true,
      registered: true,
      mode: "system" as const,
      authorizationRequired: false,
    }));
    const result = await completeInitSchedule(coreResult, projectPath, {
      register,
      emitProgress: (event) => progress.push(event),
    });

    expect(register).toHaveBeenCalledOnce();
    expect(progress.map((event) => [event.step, event.pct, event.runId])).toEqual([
      ["schedule", 96, coreResult.runId],
      ["schedule", 100, coreResult.runId],
    ]);
    expect(result).toMatchObject({ status: "ok", exitCode: EXIT.OK });
    expect(result.steps).toEqual([
      { key: "daily", status: "ok" },
      { key: "schedule", status: "ok", message: "系统定时任务已注册。" },
    ]);
  });

  it("reports resident fallback as a partial result with an actionable schedule step", async () => {
    const progress: JobProgress[] = [];
    const result = await completeInitSchedule(coreResult, projectPath, {
      register: async () => ({ enabled: true, registered: false, mode: "resident", authorizationRequired: true }),
      emitProgress: (event) => progress.push(event),
    });

    expect(result).toMatchObject({ status: "partial", exitCode: EXIT.SOURCE_FAILED });
    expect(result.steps?.at(-1)).toMatchObject({ key: "schedule", status: "failed" });
    expect(result.errors?.at(-1)).toContain("软件常驻");
    expect(progress.at(-1)).toMatchObject({ step: "schedule", pct: 100, level: "warn" });
  });
});
