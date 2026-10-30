import { INIT_STEPS, type InitStepKey, type JobProgress, type JobResult } from "@siteindex/shared";

export type InitStepStatus = "waiting" | "running" | "ok" | "failed" | "skipped";
export type InitStepState = { status: InitStepStatus; reason?: string; message?: string };
export type InitStepStates = Partial<Record<InitStepKey, InitStepState>>;
export type InitCompletionStatus = "running" | "success" | "failed" | "skipped" | "incomplete";

function initStepKey(value?: string): InitStepKey | undefined {
  return INIT_STEPS.find((key) => key === value);
}

export function applyInitProgress(current: InitStepStates, event: JobProgress): InitStepStates {
  const key = initStepKey(event.step);
  if (!key) return current;

  const next = { ...current };
  for (const previous of INIT_STEPS) {
    if (previous === key) break;
    if (next[previous]?.status === "running") next[previous] = { ...next[previous]!, status: "ok" };
  }

  next[key] = event.level === "error"
    ? { status: "failed", message: event.message, reason: event.message }
    : { status: "running", message: event.message };
  return next;
}

export function nextInitProgressPercent(current: number, pct: number | null): number {
  if (pct === null || !Number.isFinite(pct)) return current;
  return Math.min(100, Math.max(0, pct));
}

export function applyInitResult(current: InitStepStates, result: JobResult): InitStepStates {
  const next = { ...current };
  const received = new Set<InitStepKey>();

  for (const step of result.steps ?? []) {
    const key = initStepKey(step.key);
    if (!key) continue;
    received.add(key);
    next[key] = step.status === "ok"
      ? { status: "ok", message: step.message }
      : step.status === "failed"
        ? { status: "failed", message: step.message, reason: step.message || result.errors?.join("；") || result.summary }
        : { status: "skipped", message: step.message, reason: step.message || "本次已跳过" };
  }

  for (const key of INIT_STEPS) {
    if (received.has(key)) continue;
    const previous = next[key];
    next[key] = previous?.status === "failed"
      ? previous
      : { status: "waiting", ...(previous?.message ? { message: previous.message } : {}), reason: "未返回步骤结果" };
  }
  return next;
}

export function unresolvedInitErrors(result: JobResult, states: InitStepStates): string[] {
  const failedSteps = (result.steps ?? []).filter((step) => step.status === "failed");
  const currentFailures = INIT_STEPS.flatMap((key) => states[key]?.status === "failed" ? [states[key]!.reason] : []);
  return (result.errors ?? []).filter((error) => {
    const matchingStep = failedSteps.find((step) => step.message === error);
    const matchingKey = initStepKey(matchingStep?.key);
    if (matchingKey && states[matchingKey]?.status === "ok") return false;
    return !currentFailures.includes(error);
  });
}

export function getInitCompletionStatus(result: JobResult | null, states: InitStepStates): InitCompletionStatus {
  if (!result) return "running";

  const failedStepKeys = (result.steps ?? []).flatMap((step) => {
    const key = initStepKey(step.key);
    return key && step.status === "failed" ? [key] : [];
  });
  const allOriginalFailuresRecovered = failedStepKeys.length > 0 && failedStepKeys.every((key) => states[key]?.status === "ok");
  const hasFailure = INIT_STEPS.some((key) => states[key]?.status === "failed")
    || unresolvedInitErrors(result, states).length > 0
    || ((result.status === "failed" || result.status === "partial") && !allOriginalFailuresRecovered);
  if (hasFailure) return "failed";

  const allResolved = INIT_STEPS.every((key) => states[key]?.status === "ok" || states[key]?.status === "skipped");
  if (!allResolved || result.status === "skipped") return "incomplete";
  return INIT_STEPS.some((key) => states[key]?.status === "skipped") ? "skipped" : "success";
}

export function scheduleRetryFailure(registered: boolean): string | undefined {
  return registered ? undefined : "系统定时任务尚未注册，请检查执行设备与系统授权后重试。";
}
