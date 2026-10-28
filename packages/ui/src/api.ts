import { isSiteIndexError, type SiteIndexApi } from "@siteindex/shared";

let mock: SiteIndexApi | undefined;
const hostApi = typeof window === "undefined" ? undefined : window.siteindex;

if (!hostApi) {
  if (import.meta.env.DEV || import.meta.env.VITE_MOCK === "1") {
    const module = await import("./mock");
    mock = module.createMockApi();
  } else {
    throw new Error("SiteIndex API 不可用：请从桌面应用打开本应用。");
  }
}

export const api: SiteIndexApi = hostApi ?? mock!;
export const isMockApi = Boolean(mock);
export interface ApiErrorDetails {
  message: string;
  code?: string;
}

export const apiErrorDetails = (error: unknown): ApiErrorDetails | null => {
  if (!isSiteIndexError(error) || typeof error.message !== "string") return null;
  return {
    message: error.message,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
  };
};

export const apiErrorMessage = (error: unknown, fallback: string): string =>
  apiErrorDetails(error)?.message ?? fallback;
if (typeof window !== "undefined" && !window.siteindex && mock) window.siteindex = mock;
