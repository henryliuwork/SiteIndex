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
    return { available: false, message: "当前版本暂未开放图片准备功能。" };
  }
  if (typeof api.media?.prepare !== "function") {
    return { available: false, message: "当前桌面版暂未提供图片准备接口，不能执行图片处理。" };
  }
  return { available: true, message: "" };
}
