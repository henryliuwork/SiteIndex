import type { SiteIndexApi } from "@siteindex/shared";

let mock: SiteIndexApi | undefined;

if (!window.siteindex) {
  if (import.meta.env.DEV || import.meta.env.VITE_MOCK === "1") {
    const module = await import("./mock");
    mock = module.createMockApi();
  } else {
    throw new Error("SiteIndex API 不可用：请从桌面应用打开，或使用开发 mock。");
  }
}

export const api: SiteIndexApi = window.siteindex ?? mock!;
