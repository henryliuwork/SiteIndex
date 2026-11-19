import type { ISODate, SeoIssue, SeoPage, SeoPageTableQuery, SeoPageTableResult, SeoPageTableRow } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

function compareNullable(left: string | number | boolean | null | undefined, right: typeof left, direction: number): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return (left < right ? -1 : 1) * direction;
  if (typeof left === "boolean" && typeof right === "boolean") return (left ? 1 : -1) * direction;
  return compareKeys(String(left), String(right)) * direction;
}

function sortValue(row: SeoPageTableRow, field: NonNullable<SeoPageTableQuery["sort"]>["field"]): string | number | boolean | null | undefined {
  if (field === "open_high") return row.open_issue_counts.high;
  if (field === "open_mid") return row.open_issue_counts.mid;
  if (field === "open_low") return row.open_issue_counts.low;
  if (field === "new_open_issues") return row.new_open_issue_count;
  return row[field];
}

function latestDate(values: readonly (string | null | undefined)[]): ISODate | null {
  return values.filter((value): value is string => !!value).sort(compareKeys).at(-1)?.slice(0, 10) ?? null;
}

function dateInTimezone(timestamp: string, formatter: Intl.DateTimeFormat): ISODate {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Read-only page-level SEO aggregation; stored pages and issues remain unchanged. */
export function listSeoPageRows(
  pages: readonly SeoPage[], issues: readonly SeoIssue[], query: SeoPageTableQuery, timezone = "UTC",
): SeoPageTableResult {
  const latestCrawlDate = latestDate(pages.map((page) => page.last_crawled));
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const byUrl = new Map<string, SeoIssue[]>();
  for (const issue of issues) {
    const group = byUrl.get(issue.url) ?? [];
    group.push(issue);
    byUrl.set(issue.url, group);
  }
  const summary: SeoPageTableResult["summary"] = {
    latest_crawl_date: latestCrawlDate, open_pages: 0, new_pages: 0, unindexed_pages: 0, fixed_pages: 0,
  };
  const filters = query.filters;
  const needle = query.search?.trim().toLowerCase();
  const hasIssueFilter = !!(filters?.rules?.length || filters?.severity || filters?.status);
  const rows: SeoPageTableRow[] = [];
  for (const page of pages) {
    const pageIssues = byUrl.get(page.url) ?? [];
    const open = pageIssues.filter((issue) => issue.status === "open");
    const fixed = pageIssues.some((issue) => issue.status === "fixed");
    const newOpen = latestCrawlDate === null ? [] : open.filter((issue) => issue.first_seen === latestCrawlDate);
    if (open.length) summary.open_pages += 1;
    if (newOpen.length) summary.new_pages += 1;
    if (page.google_indexed === false) summary.unindexed_pages += 1;
    if (fixed) summary.fixed_pages += 1;

    if (filters?.page_type && page.page_type !== filters.page_type) continue;
    if (filters?.indexed === "yes" && page.google_indexed !== true) continue;
    if (filters?.indexed === "no" && page.google_indexed !== false) continue;
    if (filters?.indexed === "unchecked" && page.google_indexed !== null && page.google_indexed !== undefined) continue;
    if (filters?.has_open_issues === true && !open.length) continue;
    if (filters?.has_open_issues === false && open.length) continue;
    if (filters?.summary === "open" && !open.length) continue;
    if (filters?.summary === "new" && !newOpen.length) continue;
    if (filters?.summary === "unindexed" && page.google_indexed !== false) continue;
    if (filters?.summary === "fixed" && !fixed) continue;
    const matched = pageIssues.filter((issue) => (!filters?.rules?.length || filters.rules.includes(issue.rule))
      && (!filters?.severity || issue.severity === filters.severity)
      && (!filters?.status || issue.status === filters.status));
    if (hasIssueFilter && !matched.length) continue;
    if (needle && ![page.url, page.title, page.meta_description, page.page_type,
      ...pageIssues.flatMap((issue) => [issue.rule, issue.detail, issue.severity, issue.status])]
      .some((value) => value?.toLowerCase().includes(needle))) continue;

    const handledAt = pageIssues.map((issue) => issue.handled_at).filter((value): value is string => !!value)
      .sort(compareKeys).at(-1) ?? null;
    const targets = new Map(open.map((issue) => [issue.rule, { url: page.url, rule: issue.rule }]));
    rows.push({
      ...page,
      open_issue_counts: {
        high: open.filter((issue) => issue.severity === "high").length,
        mid: open.filter((issue) => issue.severity === "mid").length,
        low: open.filter((issue) => issue.severity === "low").length,
      },
      new_open_issue_count: newOpen.length,
      matching_issue_count: matched.length,
      open_issue_targets: [...targets.values()].sort((left, right) => compareKeys(left.rule, right.rule)),
      // Legacy fixed rows do not say whether last_seen was an automatic or manual transition.
      last_issue_change_date: latestDate(pageIssues.flatMap((issue) => [issue.first_seen,
        issue.auto_status_changed_on,
        ...(issue.handled_at ? [dateInTimezone(issue.handled_at, dateFormatter)] : [])])),
      last_issue_handled_at: handledAt,
    });
  }

  const sort = query.sort;
  rows.sort((left, right) => {
    if (sort) return compareNullable(sortValue(left, sort.field), sortValue(right, sort.field), sort.dir === "desc" ? -1 : 1)
      || compareKeys(left.url, right.url);
    return right.open_issue_counts.high - left.open_issue_counts.high
      || right.new_open_issue_count - left.new_open_issue_count || compareKeys(left.url, right.url);
  });
  const total = rows.length;
  if (query.pageSize === 0) return { rows, total, summary };
  const page = Math.max(1, Math.floor(query.page || 1));
  const pageSize = Math.max(1, Math.floor(query.pageSize || 20));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, summary };
}
