import type { PageType, SeoIssue, SeoIssueFilters, SeoPageFilters, Severity } from "@siteindex/shared";

export type SeoView = "issues" | "pages" | "links";
export interface SeoRouteFilters {
  view: SeoView;
  issues: SeoIssueFilters;
  pages: SeoPageFilters;
}
export type SeoSearchParamPatch = Record<string, string | string[] | null>;

const issueStatuses = new Set<SeoIssue["status"]>(["open", "fixed", "ignored"]);
const severities = new Set<Severity>(["high", "mid", "low"]);
const pageTypes = new Set<PageType>(["home", "collection", "product", "blog", "page", "other"]);
const indexedStatuses = new Set<NonNullable<SeoPageFilters["indexed"]>>(["yes", "no", "unchecked"]);

export function seoRouteFiltersFromSearchParams(params: URLSearchParams): SeoRouteFilters {
  const ruleValues = params.getAll("rule").flatMap((value) => value.split(",").map((rule) => rule.trim()).filter(Boolean));
  const rules = [...new Set(ruleValues)];
  const status = params.get("status");
  const severity = params.get("severity");
  const pageType = params.get("page_type");
  const indexed = params.get("indexed");
  const viewParam = params.get("view");

  return {
    view: viewParam === "pages" || viewParam === "links" ? viewParam : "issues",
    issues: {
      ...(rules.length ? { rules } : {}),
      ...(status && issueStatuses.has(status as SeoIssue["status"]) ? { status: status as SeoIssue["status"] } : {}),
      ...(severity && severities.has(severity as Severity) ? { severity: severity as Severity } : {}),
    },
    pages: {
      ...(pageType && pageTypes.has(pageType as PageType) ? { page_type: pageType as PageType } : {}),
      ...(indexed && indexedStatuses.has(indexed as NonNullable<SeoPageFilters["indexed"]>) ? { indexed: indexed as NonNullable<SeoPageFilters["indexed"]> } : {}),
    },
  };
}

export function searchTextFromSearchParams(params: URLSearchParams): string {
  return params.get("q") ?? "";
}

export function updateSeoSearchParams(current: URLSearchParams, patch: SeoSearchParamPatch): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    next.delete(key);
    if (Array.isArray(value)) value.forEach((item) => next.append(key, item));
    else if (value) next.set(key, value);
  }
  return next;
}
