import { PENDING_HANDLERS, type SiteIndexApi } from "@siteindex/shared";

export interface EdmMediaCapability {
  available: boolean;
  message: string;
}

export function getEdmMediaCapability(
  api: SiteIndexApi,
  pendingHandlers: readonly string[] = PENDING_HANDLERS,
): EdmMediaCapability {
  if (pendingHandlers.includes("media.prepare")) {
    return { available: false, message: "media.prepare 尚未完成 Core 与 Desktop 接入，当前不能执行图片处理。" };
  }
  if (typeof api.media?.prepare !== "function") {
    return { available: false, message: "当前桌面版尚未提供 media.prepare，不能执行图片处理。" };
  }
  return { available: true, message: "" };
}
