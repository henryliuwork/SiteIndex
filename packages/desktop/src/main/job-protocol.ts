import type { AppSettings, JobName, JobProgress, JobRequest, JobResult, JobTrigger } from "@siteindex/shared";

export type JobStartRequest = Omit<JobRequest, "trigger"> & { trigger: JobTrigger };

export interface JobWorkerContext {
  deviceId: string;
  deviceName: string;
  cacheDir: string;
}

export interface JobWorkerStartMessage {
  type: "run";
  request: JobStartRequest;
  context: JobWorkerContext;
}

export type JobWorkerMessage =
  | { type: "ready" }
  | { type: "started"; runId: string; startedAt: string }
  | { type: "progress"; progress: JobProgress }
  | { type: "finished"; result: JobResult; oosRate: number | null }
  | { type: "fatal"; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJobName(value: unknown): value is JobName {
  return (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "validate" ||
    value === "readme" ||
    value === "design" ||
    value === "index-check" ||
    value === "views"
  );
}

export function isJobProgress(value: unknown): value is JobProgress {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === "string" &&
    typeof value.projectPath === "string" &&
    isJobName(value.job) &&
    (typeof value.pct === "number" || value.pct === null) &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.message === "string" &&
    typeof value.at === "string"
  );
}

export function isJobResult(value: unknown): value is JobResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === "string" &&
    isJobName(value.job) &&
    (value.status === "ok" || value.status === "partial" || value.status === "failed" || value.status === "skipped") &&
    typeof value.exitCode === "number" &&
    typeof value.summary === "string"
  );
}

export function shouldNotify(settings: AppSettings, result: JobResult, oosRate: number | null): boolean {
  if (result.status === "skipped") return false;
  if (result.status === "failed" && settings.notify.on_failure) return true;
  if ((result.status === "ok" || result.status === "partial") && settings.notify.on_success) return true;
  const threshold = settings.notify.oos_threshold;
  return (
    result.job === "daily" &&
    result.status !== "failed" &&
    threshold !== null &&
    oosRate !== null &&
    oosRate >= threshold
  );
}
