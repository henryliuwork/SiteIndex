import { describe, expect, it, vi } from "vitest";
import type { SiteIndexApi } from "@siteindex/shared";
import { getEdmMediaCapability } from "./media-capability";

function apiWithMediaPrepare(): SiteIndexApi {
  return { media: { prepare: vi.fn(async () => ({ runId: "demo-run" })) } } as unknown as SiteIndexApi;
}

describe("getEdmMediaCapability", () => {
  it("版本门禁关闭时不开放图片准备，并准确说明当前版本暂未开放", () => {
    const capability = getEdmMediaCapability(apiWithMediaPrepare(), ["media.prepare"]);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("当前版本暂未开放图片准备功能");
  });

  it("Desktop bridge 缺少方法时保持关闭", () => {
    const capability = getEdmMediaCapability({} as SiteIndexApi, []);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("暂未提供图片准备接口");
  });

  it("handler 从 pending 清单移除且方法存在时开放真实图片处理", () => {
    expect(getEdmMediaCapability(apiWithMediaPrepare(), []).available).toBe(true);
  });
});
