import type { JobRequest, ScheduleConfig, SiteIndexError } from "@siteindex/shared";

export function isJobRequest(value: unknown): value is Omit<JobRequest, "trigger"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.projectPath === "string" &&
    request.projectPath.trim().length > 0 &&
    (request.job === "daily" ||
      request.job === "weekly" ||
      request.job === "monthly" ||
      request.job === "validate" ||
      request.job === "readme" ||
      request.job === "design" ||
      request.job === "index-check" ||
      request.job === "views") &&
    (request.only === undefined || typeof request.only === "string") &&
    (request.date === undefined || typeof request.date === "string") &&
    (request.force === undefined || typeof request.force === "boolean") &&
    (request.dryRun === undefined || typeof request.dryRun === "boolean")
  );
}

export function invalidJobRequest(message: string): SiteIndexError {
  return { code: "CONFIG_INVALID", message };
}

export function isScheduleConfig(value: unknown): value is ScheduleConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const keys = ["daily", "validate", "weekly", "readme", "monthly"] as const;
  for (const key of keys) {
    const entry = config[key];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const schedule = entry as Record<string, unknown>;
    if (
      typeof schedule.enabled !== "boolean" ||
      typeof schedule.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)
    ) {
      return false;
    }
    if (key === "monthly") {
      if (
        schedule.day_of_month !== undefined &&
        (!Number.isInteger(schedule.day_of_month) ||
          Number(schedule.day_of_month) < 1 ||
          Number(schedule.day_of_month) > 31)
      )
        return false;
      if (schedule.enabled && schedule.day_of_month === undefined) return false;
    } else if (schedule.days !== undefined) {
      if (
        !Array.isArray(schedule.days) ||
        schedule.days.some((day) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)
      )
        return false;
      if (schedule.enabled && schedule.days.length === 0) return false;
    } else if (schedule.enabled) {
      return false;
    }
  }
  const options = config.options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return false;
  const flags = options as Record<string, unknown>;
  return ["wake_to_run", "run_if_missed", "notify_on_failure", "validate_after_sync"].every(
    (key) => typeof flags[key] === "boolean",
  );
}

export function invalidSchedule(): SiteIndexError {
  return { code: "CONFIG_INVALID", message: "定时任务计划无效。" };
}
