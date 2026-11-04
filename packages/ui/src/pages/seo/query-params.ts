import type { SeoIssueFilters } from "@siteindex/shared";

const issueStatuses = new Set<NonNullable<SeoIssueFilters["status"]>>(["open", "fixed", "ignored"]);

export function issueFiltersFromSearchParams(params: URLSearchParams): SeoIssueFilters {
  const rules = [...new Set(params.getAll("rule").flatMap((value) => value.split(",").map((rule) => rule.trim()).filter(Boolean)))];
  const status = params.get("status");
  return {
    ...(rules.length ? { rules } : {}),
    ...(status && issueStatuses.has(status as NonNullable<SeoIssueFilters["status"]>) ? { status: status as NonNullable<SeoIssueFilters["status"]> } : {}),
  };
}
