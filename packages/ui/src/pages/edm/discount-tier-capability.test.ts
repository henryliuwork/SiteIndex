import { describe, expect, it, vi } from "vitest";
import type { SiteIndexApi } from "@siteindex/shared";
import { getEdmDiscountTierCapability } from "./discount-tier-capability";

function apiWithSetter(): SiteIndexApi {
  return { edm: { setDiscountTier: vi.fn(async () => ({ sku: "DEMO001", discount_tier: 20 })) } } as unknown as SiteIndexApi;
}

describe("getEdmDiscountTierCapability", () => {
  it("handler 仍在版本待接入清单时保持只读", () => {
    const capability = getEdmDiscountTierCapability(apiWithSetter(), ["edm.setDiscountTier"]);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("尚未就绪");
  });

  it("旧 bridge 缺少可选方法时保持只读", () => {
    const capability = getEdmDiscountTierCapability({} as SiteIndexApi, []);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("暂未提供");
  });

  it("handler 就绪且方法存在时开放选择", () => {
    expect(getEdmDiscountTierCapability(apiWithSetter(), []).available).toBe(true);
  });
});
