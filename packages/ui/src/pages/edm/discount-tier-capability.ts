import { PENDING_HANDLERS, type SiteIndexApi } from "@siteindex/shared";

export interface EdmDiscountTierCapability {
  available: boolean;
  message: string;
}

export function getEdmDiscountTierCapability(
  api: SiteIndexApi,
  pendingHandlers: readonly string[] = PENDING_HANDLERS,
): EdmDiscountTierCapability {
  if (pendingHandlers.includes("edm.setDiscountTier")) {
    return { available: false, message: "当前版本的折扣档位保存接口尚未就绪。" };
  }
  if (typeof api.edm?.setDiscountTier !== "function") {
    return { available: false, message: "当前桌面版暂未提供折扣档位保存接口。" };
  }
  return { available: true, message: "" };
}
