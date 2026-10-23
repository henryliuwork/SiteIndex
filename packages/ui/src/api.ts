import type { SiteIndexApi } from "@siteindex/shared";

let mock: SiteIndexApi | undefined;
const hostApi = typeof window === "undefined" ? undefined : window.siteindex;

if (!hostApi) {
  if (import.meta.env.DEV || import.meta.env.VITE_MOCK === "1") {
    const module = await import("./mock");
    mock = module.createMockApi();
  } else {
    throw new Error("SiteIndex API 不可用：请从桌面应用打开，或使用开发 mock。");
  }
}

export const api: SiteIndexApi = hostApi ?? mock!;
export const isMockApi = Boolean(mock);
if (typeof window !== "undefined" && !window.siteindex && mock) window.siteindex = mock;
