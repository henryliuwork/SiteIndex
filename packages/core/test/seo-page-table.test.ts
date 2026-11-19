import { describe, expect, it } from "vitest";
import type { SeoIssue, SeoPage } from "@siteindex/shared";
import { listSeoPageRows } from "../src/seo/page-table";

const base = "https://demo-shop.test";

function page(slug: string, indexed: boolean | null = true, lastCrawled = "2026-11-19"): SeoPage {
  return {
    url: `${base}/${slug}`, page_type: "product", status_code: 200, title: slug,
    title_length: slug.length, meta_description: null, description_length: 0,
    h1: slug, h1_count: 1, canonical: null, canonical_status: "missing",
    robots_meta: null, x_robots_tag: null, indexable: true, in_sitemap: true,
    google_indexed: indexed, schema_types: [], word_count: null, last_crawled: lastCrawled,
  };
}

function issue(slug: string, rule: SeoIssue["rule"], severity: SeoIssue["severity"],
  status: SeoIssue["status"], firstSeen: string, extra: Partial<SeoIssue> = {}): SeoIssue {
  return {
    url: `${base}/${slug}`, rule, severity, status, detail: `虚构 ${rule}`,
    first_seen: firstSeen, last_seen: "2026-11-19", ...extra,
  };
}

const pages = [page("z"), page("b"), page("a"), page("c", false), page("d", true, "2026-11-18")];
const issues: SeoIssue[] = [
  issue("a", "desc_missing", "high", "open", "2026-11-19"),
  issue("a", "title_missing", "mid", "open", "2026-11-18"),
  issue("a", "canonical_missing", "low", "fixed", "2026-11-01", { last_seen: "2026-11-19" }),
  issue("b", "desc_missing", "high", "open", "2026-11-18"),
  issue("b", "schema_missing", "low", "open", "2026-11-18"),
  issue("z", "desc_missing", "high", "open", "2026-11-19"),
  issue("d", "title_missing", "mid", "fixed", "2026-11-03", {
    handled_at: "2026-11-18T12:34:56.000Z", last_seen: "2026-11-04",
  }),
];

describe("SEO page table aggregation", () => {
  it("counts site-wide page sets and sorts all rows before pagination with a stable URL tie", () => {
    const first = listSeoPageRows(pages, issues, { page: 1, pageSize: 2 });
    const second = listSeoPageRows([...pages].reverse(), [...issues].reverse(), { page: 2, pageSize: 2 });

    expect(first.summary).toEqual({
      latest_crawl_date: "2026-11-19", open_pages: 3, new_pages: 2,
      unindexed_pages: 1, fixed_pages: 2,
    });
    expect(first.total).toBe(5);
    expect(first.rows.map((row) => row.url)).toEqual([`${base}/a`, `${base}/z`]);
    expect(second.rows.map((row) => row.url)).toEqual([`${base}/b`, `${base}/c`]);
    expect(first.rows[0]).toMatchObject({
      open_issue_counts: { high: 1, mid: 1, low: 0 }, new_open_issue_count: 1,
      matching_issue_count: 3, open_issue_targets: [
        { url: `${base}/a`, rule: "desc_missing" }, { url: `${base}/a`, rule: "title_missing" },
      ],
    });
    expect(listSeoPageRows(pages, issues, { page: 1, pageSize: 0 }).rows.map((row) => row.url))
      .toEqual([`${base}/a`, `${base}/z`, `${base}/b`, `${base}/c`, `${base}/d`]);
  });

  it("requires one issue to satisfy rule, severity and status together", () => {
    const matching = listSeoPageRows(pages, issues, {
      page: 1, pageSize: 0, filters: { rules: ["desc_missing"], severity: "high", status: "open" },
    });
    expect(matching.rows.map((row) => row.url)).toEqual([`${base}/a`, `${base}/z`, `${base}/b`]);
    expect(matching.rows.map((row) => row.matching_issue_count)).toEqual([1, 1, 1]);
    const noCrossIssueMatch = listSeoPageRows(pages, issues, {
      page: 1, pageSize: 0, filters: { rules: ["desc_missing"], severity: "mid", status: "open" },
    });
    expect(noCrossIssueMatch.total).toBe(0);
    expect(noCrossIssueMatch.summary).toEqual(matching.summary);
    expect(listSeoPageRows(pages, issues, {
      page: 1, pageSize: 0, search: "虚构 schema_missing", filters: { status: "open", has_open_issues: true },
    }).rows.map((row) => row.url)).toEqual([`${base}/b`]);
  });

  it("uses page sets for all four summary links and keeps open counts independent of a fixed filter", () => {
    const urls = (summary: "open" | "new" | "unindexed" | "fixed") => listSeoPageRows(pages, issues, {
      page: 1, pageSize: 0, filters: { summary },
    }).rows.map((row) => row.url);
    expect(urls("open")).toEqual([`${base}/a`, `${base}/z`, `${base}/b`]);
    expect(urls("new")).toEqual([`${base}/a`, `${base}/z`]);
    expect(urls("unindexed")).toEqual([`${base}/c`]);
    expect(urls("fixed")).toEqual([`${base}/a`, `${base}/d`]);
    const fixed = listSeoPageRows(pages, issues, { page: 1, pageSize: 0, filters: { status: "fixed" } });
    expect(fixed.rows[0]).toMatchObject({
      url: `${base}/a`, matching_issue_count: 1, open_issue_counts: { high: 1, mid: 1, low: 0 },
    });
    expect(listSeoPageRows(pages, issues, { page: 1, pageSize: 0, filters: { has_open_issues: false } })
      .rows.map((row) => row.url)).toEqual([`${base}/c`, `${base}/d`]);
  });

  it("keeps unknown legacy manual time absent and exposes only evidenced change dates", () => {
    const rows = listSeoPageRows(pages, issues, { page: 1, pageSize: 0 }).rows;
    expect(rows.find((row) => row.url === `${base}/a`)).toMatchObject({
      last_issue_change_date: "2026-11-19", last_issue_handled_at: null,
    });
    expect(rows.find((row) => row.url === `${base}/d`)).toMatchObject({
      last_issue_change_date: "2026-11-18", last_issue_handled_at: "2026-11-18T12:34:56.000Z",
    });
    expect(rows.find((row) => row.url === `${base}/c`)).toMatchObject({
      last_issue_change_date: null, last_issue_handled_at: null,
    });
    const oldFixed = listSeoPageRows([page("legacy")], [issue("legacy", "orphan", "low", "fixed", "2026-11-01", {
      last_seen: "2026-11-19",
    })], { page: 1, pageSize: 0 });
    expect(oldFixed.rows[0]).toMatchObject({ last_issue_change_date: "2026-11-01", last_issue_handled_at: null });
    const autoFixed = listSeoPageRows([page("auto")], [issue("auto", "orphan", "low", "fixed", "2026-11-01", {
      auto_status_changed_on: "2026-11-18", last_seen: "2026-11-19",
    })], { page: 1, pageSize: 0 });
    expect(autoFixed.rows[0]).toMatchObject({ last_issue_change_date: "2026-11-18", last_issue_handled_at: null });
  });

  it("supports explicit numeric and nullable sorts and empty projects", () => {
    const byInbound = listSeoPageRows([page("b"), { ...page("a"), links_internal_in: 3 }, page("c")], [], {
      page: 1, pageSize: 0, sort: { field: "links_internal_in", dir: "desc" },
    });
    expect(byInbound.rows.map((row) => row.url)).toEqual([`${base}/a`, `${base}/b`, `${base}/c`]);
    expect(listSeoPageRows([], [], { page: 1, pageSize: 50 })).toEqual({
      rows: [], total: 0, summary: {
        latest_crawl_date: null, open_pages: 0, new_pages: 0, unindexed_pages: 0, fixed_pages: 0,
      },
    });
    const timezoneRow = listSeoPageRows([page("timezone")], [issue("timezone", "orphan", "low", "ignored", "2026-11-01", {
      handled_at: "2026-11-19T01:00:00.000Z",
    })], { page: 1, pageSize: 50 }, "America/Los_Angeles").rows[0];
    expect(timezoneRow?.last_issue_change_date).toBe("2026-11-18");
  });
});
