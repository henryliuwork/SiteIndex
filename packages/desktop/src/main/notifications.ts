import { Notification } from "electron";
import type { AppSettings, JobResult } from "@siteindex/shared";
import { shouldNotify } from "./job-protocol.js";

export function showJobNotification(result: JobResult, settings: AppSettings, oosRate: number | null): void {
  if (!Notification.isSupported() || !shouldNotify(settings, result, oosRate)) return;

  const threshold = settings.notify.oos_threshold;
  const thresholdReached = result.job === "daily" && oosRate !== null && threshold !== null && oosRate >= threshold;
  const body = thresholdReached
    ? `${result.summary} 当前缺货率 ${(oosRate * 100).toFixed(1)}%，达到 ${(threshold * 100).toFixed(1)}% 提醒阈值。`
    : result.summary;
  new Notification({ title: `SiteIndex · ${result.job}`, body }).show();
}
