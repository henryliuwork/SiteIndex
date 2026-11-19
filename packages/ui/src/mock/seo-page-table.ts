import type { SeoIssue, SeoPageTableQuery, SeoPageTableResult, SeoPageTableRow } from "@siteindex/shared";
import { projectConfigs, projectKey, seoIssuesForProject, seoPages } from "./context";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function mockSeoPageRows(id: string, query: SeoPageTableQuery): SeoPageTableResult {
  const issues = seoIssuesForProject(id);
  const latest = seoPages.map((page) => page.last_crawled).sort(compare).at(-1) ?? null;
  const byUrl = new Map<string, SeoIssue[]>();
  for (const issue of issues) byUrl.set(issue.url, [...(byUrl.get(issue.url) ?? []), issue]);
  const summary = { latest_crawl_date: latest, open_pages: 0, new_pages: 0, unindexed_pages: 0, fixed_pages: 0 };
  const filters = query.filters;
  const needle = query.search?.trim().toLowerCase();
  const issueFilter = Boolean(filters?.rules?.length || filters?.severity || filters?.status);
  const timezone = projectConfigs[projectKey(id)].timezone;
  const dateFormatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const rows: SeoPageTableRow[] = [];

  for (const page of seoPages) {
    const pageIssues = byUrl.get(page.url) ?? [];
    const open = pageIssues.filter((issue) => issue.status === "open");
    const newOpen = open.filter((issue) => issue.first_seen === latest);
    const fixed = pageIssues.some((issue) => issue.status === "fixed");
    if (open.length) summary.open_pages++;
    if (newOpen.length) summary.new_pages++;
    if (page.google_indexed === false) summary.unindexed_pages++;
    if (fixed) summary.fixed_pages++;
    if (filters?.page_type && page.page_type !== filters.page_type) continue;
    if (filters?.indexed === "yes" && page.google_indexed !== true) continue;
    if (filters?.indexed === "no" && page.google_indexed !== false) continue;
    if (filters?.indexed === "unchecked" && page.google_indexed != null) continue;
    if (filters?.has_open_issues === true && !open.length) continue;
    if (filters?.has_open_issues === false && open.length) continue;
    if (filters?.summary === "open" && !open.length) continue;
    if (filters?.summary === "new" && !newOpen.length) continue;
    if (filters?.summary === "unindexed" && page.google_indexed !== false) continue;
    if (filters?.summary === "fixed" && !fixed) continue;
    const matched = pageIssues.filter((issue) => (!filters?.rules?.length || filters.rules.includes(issue.rule))
      && (!filters?.severity || issue.severity === filters.severity)
      && (!filters?.status || issue.status === filters.status));
    if (issueFilter && !matched.length) continue;
    if (needle && ![page.url, page.title, page.meta_description, page.page_type,
      ...pageIssues.flatMap((issue) => [issue.rule, issue.detail, issue.severity, issue.status])]
      .some((value) => value?.toLowerCase().includes(needle))) continue;
    const handled = pageIssues.flatMap((issue) => issue.handled_at ? [issue.handled_at] : []).sort(compare).at(-1) ?? null;
    const dates = pageIssues.flatMap((issue) => [issue.first_seen, issue.auto_status_changed_on,
      ...(issue.handled_at ? [Object.fromEntries(dateFormatter.formatToParts(new Date(issue.handled_at)).map(({ type, value }) => [type, value]))] : [])]
      .map((value) => typeof value === "string" ? value : value ? `${value.year}-${value.month}-${value.day}` : null)
      .filter((value): value is string => !!value));
    const targets = new Map(open.map((issue) => [issue.rule, { url: page.url, rule: issue.rule }]));
    rows.push({ ...page,
      open_issue_counts: { high: open.filter((issue) => issue.severity === "high").length,
        mid: open.filter((issue) => issue.severity === "mid").length,
        low: open.filter((issue) => issue.severity === "low").length },
      new_open_issue_count: newOpen.length, matching_issue_count: matched.length,
      open_issue_targets: [...targets.values()].sort((a, b) => compare(a.rule, b.rule)),
      last_issue_change_date: dates.sort(compare).at(-1) ?? null,
      last_issue_handled_at: handled,
    });
  }
  const value = (row: SeoPageTableRow, field: NonNullable<SeoPageTableQuery["sort"]>["field"]) =>
    field === "open_high" ? row.open_issue_counts.high : field === "open_mid" ? row.open_issue_counts.mid
      : field === "open_low" ? row.open_issue_counts.low : field === "new_open_issues" ? row.new_open_issue_count : row[field];
  rows.sort((a, b) => {
    if (!query.sort) return b.open_issue_counts.high - a.open_issue_counts.high
      || b.new_open_issue_count - a.new_open_issue_count || compare(a.url, b.url);
    const left = value(a, query.sort.field), right = value(b, query.sort.field);
    if (left == null || right == null) return (left == null ? 1 : 0) - (right == null ? 1 : 0) || compare(a.url, b.url);
    const direction = query.sort.dir === "desc" ? -1 : 1;
    return (typeof left === "number" && typeof right === "number" ? left - right : compare(String(left), String(right))) * direction || compare(a.url, b.url);
  });
  const total = rows.length;
  if (query.pageSize === 0) return { rows, total, summary };
  const page = Math.max(1, Math.floor(query.page || 1));
  const pageSize = Math.max(1, Math.floor(query.pageSize || 20));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, summary };
}
