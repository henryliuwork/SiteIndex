import { Notification } from "electron";
import type { AppSettings, JobResult, SiteIndexError } from "@siteindex/shared";
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

export async function sendDingTalkTestNotification(webhook: string | null): Promise<void> {
  if (!webhook?.trim()) {
    throw { code: "CONFIG_INVALID", message: "请先填写钉钉机器人 Webhook。" } satisfies SiteIndexError;
  }

  let endpoint: URL;
  try {
    endpoint = new URL(webhook.trim());
  } catch {
    throw { code: "CONFIG_INVALID", message: "钉钉机器人 Webhook 格式无效。" } satisfies SiteIndexError;
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "oapi.dingtalk.com" ||
    endpoint.pathname !== "/robot/send" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw { code: "CONFIG_INVALID", message: "只支持标准的钉钉机器人 Webhook 地址。" } satisfies SiteIndexError;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: "SiteIndex 测试通知" } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw { code: "UNKNOWN", message: "测试通知发送失败，请检查网络和 Webhook 设置。" } satisfies SiteIndexError;
  }
  if (!response.ok) {
    throw {
      code: "UNKNOWN",
      message: "钉钉服务器未接受测试通知。",
      detail: `HTTP ${response.status}`,
    } satisfies SiteIndexError;
  }

  const result: unknown = await response.json().catch(() => null);
  if (
    typeof result !== "object" ||
    result === null ||
    !("errcode" in result) ||
    result.errcode !== 0
  ) {
    throw { code: "UNKNOWN", message: "钉钉机器人未接受测试通知，请检查 Webhook 设置。" } satisfies SiteIndexError;
  }
}
