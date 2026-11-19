import { describe, expect, it } from "vitest";
import type {
  SeoPageTableQuery,
  SeoPageTableResult,
  SeoPageTableRow,
  SeoIssue,
  SiteIndexApi,
} from "../src";
import { API_INVOKE_METHODS, PENDING_HANDLERS } from "../src";

describe("SEO page table additive contract", () => {
  it("leaves older SEO bridges valid after registering the implemented invoke method", () => {
    const oldSeoBridge: Pick<SiteIndexApi["seo"], "listPageRows"> = {};

    expect(oldSeoBridge.listPageRows).toBeUndefined();
    expect(API_INVOKE_METHODS.filter((method) => method === "seo.listPageRows")).toHaveLength(1);
    expect(PENDING_HANDLERS).not.toContain("seo.listPageRows");
  });

  it("types page-level issue filters, summary links, and server-side sort without changing old queries", () => {
    const oldDeepLink: SeoPageTableQuery = {
      page: 1,
      pageSize: 50,
      filters: { rules: ["desc_duplicate"], status: "open", severity: "high" },
    };
    const summaryLink: SeoPageTableQuery = {
      page: 1,
      pageSize: 0,
      filters: { summary: "new", has_open_issues: true, indexed: "no" },
      sort: { field: "new_open_issues", dir: "desc" },
    };

    expect(oldDeepLink.filters).toEqual({ rules: ["desc_duplicate"], status: "open", severity: "high" });
    expect(summaryLink).toMatchObject({ pageSize: 0, filters: { summary: "new" }, sort: { field: "new_open_issues" } });
  });

  it("returns page counts and exact open targets while keeping unavailable change time null", () => {
    const row: SeoPageTableRow = {
      url: "https://example-shop.test/demo",
      page_type: "product",
      status_code: 200,
      title: "Demo product",
      title_length: 12,
      meta_description: null,
      description_length: 0,
      h1: "Demo product",
      h1_count: 1,
      canonical: null,
      canonical_status: "missing",
      robots_meta: null,
      x_robots_tag: null,
      indexable: true,
      in_sitemap: true,
      schema_types: [],
      word_count: null,
      last_crawled: "2026-11-18",
      open_issue_counts: { high: 1, mid: 0, low: 0 },
      new_open_issue_count: 1,
      matching_issue_count: 1,
      open_issue_targets: [{ url: "https://example-shop.test/demo", rule: "canonical_missing" }],
      last_issue_change_date: "2026-11-18",
      last_issue_handled_at: null,
    };
    const result: SeoPageTableResult = {
      rows: [row],
      total: 1,
      summary: {
        latest_crawl_date: "2026-11-18",
        open_pages: 1,
        new_pages: 1,
        unindexed_pages: 0,
        fixed_pages: 0,
      },
    };

    expect(result.rows[0]?.open_issue_targets).toEqual([{ url: row.url, rule: "canonical_missing" }]);
    expect(result.rows[0]?.last_issue_handled_at).toBeNull();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    const oldIssue: SeoIssue = {
      url: row.url, rule: "canonical_missing", severity: "high", detail: "Missing canonical",
      status: "fixed", first_seen: "2026-11-17", last_seen: "2026-11-18",
    };
    expect(oldIssue.handled_at).toBeUndefined();
  });
});
