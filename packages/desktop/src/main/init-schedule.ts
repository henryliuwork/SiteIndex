import { EXIT, type JobProgress, type JobResult } from "@siteindex/shared";

export interface InitScheduleRegistration {
  enabled: boolean;
  registered: boolean;
  mode: "system" | "resident";
  authorizationRequired: boolean;
}

export interface InitScheduleOptions {
  register(): Promise<InitScheduleRegistration>;
  emitProgress(progress: JobProgress): void;
}

function scheduleResult(result: JobResult, status: "ok" | "failed" | "skipped", message: string): JobResult {
  const failed = status === "failed";
  return {
    ...result,
    status: failed && result.status === "ok" ? "partial" : result.status,
    exitCode: failed && result.exitCode === EXIT.OK ? EXIT.SOURCE_FAILED : result.exitCode,
    summary: failed ? `${result.summary} ${message}` : result.summary,
    ...(failed ? { errors: [...(result.errors ?? []), message] } : {}),
    steps: [...(result.steps ?? []).filter((step) => step.key !== "schedule"), { key: "schedule", status, message }],
  };
}

export async function completeInitSchedule(
  result: JobResult,
  projectPath: string,
  options: InitScheduleOptions,
): Promise<JobResult> {
  const emit = (pct: number, level: JobProgress["level"], message: string): void =>
    options.emitProgress({
      runId: result.runId,
      projectPath,
      job: "init",
      pct,
      step: "schedule",
      level,
      message,
      at: new Date().toISOString(),
    });

  if (result.status === "skipped") {
    const message = "初始化未执行，已跳过定时任务注册。";
    emit(100, "warn", message);
    return scheduleResult(result, "skipped", message);
  }

  emit(96, "info", "正在注册系统定时任务…");
  try {
    const registration = await options.register();
    if (!registration.enabled) {
      const message = "项目未启用定时任务。";
      emit(100, "info", message);
      return scheduleResult(result, "skipped", message);
    }
    if (registration.registered && registration.mode === "system" && !registration.authorizationRequired) {
      const message = "系统定时任务已注册。";
      emit(100, "info", message);
      return scheduleResult(result, "ok", message);
    }
    const message =
      registration.mode === "resident"
        ? "系统计划任务未注册，已启用软件常驻调度；关闭软件后不会执行。"
        : "系统计划任务尚未注册，请在运行页授权更新。";
    emit(100, "warn", message);
    return scheduleResult(result, "failed", message);
  } catch (error) {
    const message = `系统计划任务注册失败：${error instanceof Error ? error.message : String(error)}`;
    emit(100, "error", message);
    return scheduleResult(result, "failed", message);
  }
}
