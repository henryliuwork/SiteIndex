import { INIT_STEPS, type JobProgress, type JobResult } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import {
  applyInitProgress,
  applyInitResult,
  finalInitProgressPercent,
  getInitCompletionStatus,
  nextInitProgressPercent,
  scheduleRetryFailure,
  type InitStepStates,
} from "./init-state";

const progress = (step: string, pct: number | null, message: string, level: JobProgress["level"] = "info"): JobProgress => ({
  runId: "init-1",
  projectPath: "D:/SiteIndex/projects/demo",
  job: "init",
  pct,
  step,
  level,
  message,
  at: "2026-10-30T00:00:00.000Z",
});

const result = (steps: NonNullable<JobResult["steps"]>, status: JobResult["status"] = "ok", errors?: string[]): JobResult => ({
  runId: "init-1",
  job: "init",
  status,
  exitCode: status === "ok" ? 0 : 1,
  summary: status === "ok" ? "项目初始化完成。" : "项目初始化部分完成，请查看失败步骤。",
  ...(errors ? { errors } : {}),
  steps,
});

const allOk = () => INIT_STEPS.map((key) => ({ key, status: "ok" as const, message: `${key}完成。` }));

describe("新建项目 init 八步状态", () => {
  it("保留 JobProgress 的百分比和当前步骤消息", () => {
    const states = applyInitProgress({}, progress("daily", 37, "正在读取商品 Feed"));

    expect(states.daily).toEqual({ status: "running", message: "正在读取商品 Feed" });
    expect(nextInitProgressPercent(20, 37)).toBe(37);
    expect(nextInitProgressPercent(37, null)).toBe(37);
    expect(nextInitProgressPercent(37, 120)).toBe(100);
  });

  it("最终结果明确呈现 skipped 及中文原因，不把跳过说成失败", () => {
    const steps = allOk().map((step) => step.key === "schedule"
      ? { key: step.key, status: "skipped" as const, message: "项目未启用定时任务。" }
      : step);
    const finalResult = result(steps);
    const states = applyInitResult({}, finalResult);

    expect(states.schedule).toEqual({ status: "skipped", message: "项目未启用定时任务。", reason: "项目未启用定时任务。" });
    expect(getInitCompletionStatus(finalResult, states)).toBe("skipped");
  });

  it("失败步骤保留原因；重试成功后完成状态恢复", () => {
    const dailyError = "首次每日同步失败：模拟 Feed 请求超时。";
    const steps = allOk().map((step) => step.key === "daily"
      ? { key: step.key, status: "failed" as const, message: dailyError }
      : step);
    const finalResult = result(steps, "partial", [dailyError]);
    const failedStates = applyInitResult({}, finalResult);

    expect(failedStates.daily).toMatchObject({ status: "failed", reason: dailyError });
    expect(getInitCompletionStatus(finalResult, failedStates)).toBe("failed");

    const retriedStates: InitStepStates = { ...failedStates, daily: { status: "ok" } };
    expect(getInitCompletionStatus(finalResult, retriedStates)).toBe("success");
  });

  it("未返回的步骤保持等待并标明原因，不推断为成功", () => {
    const states = applyInitResult({}, result([{ key: "folders", status: "ok" }]));

    expect(states.folders?.status).toBe("ok");
    expect(states.schedule).toMatchObject({ status: "waiting", reason: "未返回步骤结果" });
    expect(getInitCompletionStatus(result([{ key: "folders", status: "ok" }]), states)).toBe("incomplete");
  });

  it("失败进度不能掩盖最终结果缺步，完成进度按结果步骤覆盖率计算", () => {
    const incompleteResult = result(allOk().filter((step) => step.key !== "schedule"));
    const progressStates = applyInitProgress({}, progress("schedule", 96, "注册失败", "error"));
    const states = applyInitResult(progressStates, incompleteResult);

    expect(states.schedule?.status).toBe("failed");
    expect(getInitCompletionStatus(incompleteResult, states)).toBe("incomplete");
    expect(finalInitProgressPercent(incompleteResult)).toBe(87.5);
    expect(finalInitProgressPercent(result(allOk()))).toBe(100);
  });

  it("重试调度时只有 Desktop 确认 registered 才显示成功", () => {
    expect(scheduleRetryFailure(true)).toBeUndefined();
    expect(scheduleRetryFailure(false)).toContain("系统授权");
  });
});
