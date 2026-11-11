import { describe, expect, it, vi } from "vitest";
import type { SiteIndexApi } from "@siteindex/shared";
import { getEdmMediaCapability } from "./media-capability";

function apiWithMediaPrepare(): SiteIndexApi {
  return { media: { prepare: vi.fn(async () => ({ runId: "demo-run" })) } } as unknown as SiteIndexApi;
}

describe("getEdmMediaCapability", () => {
  it("IPC handler 仍 pending 时不开放图片处理，即使 bridge 已暴露方法", () => {
    const capability = getEdmMediaCapability(apiWithMediaPrepare(), ["media.prepare"]);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("尚未完成 Core 与 Desktop 接入");
  });

  it("Desktop bridge 缺少方法时保持关闭", () => {
    const capability = getEdmMediaCapability({} as SiteIndexApi, []);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("尚未提供 media.prepare");
  });

  it("handler 从 pending 清单移除且方法存在时开放真实图片处理", () => {
    expect(getEdmMediaCapability(apiWithMediaPrepare(), []).available).toBe(true);
  });
});
