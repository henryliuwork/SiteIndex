import { describe, expect, it } from "vitest";
import type { ScenarioQueryResult, SiteIndexApi, SeoPageBrief, SeoInternalLinkContext } from "../src";
import { API_INVOKE_METHODS, PENDING_HANDLERS, QUERY_TARGETS } from "../src";

describe("SEO scenario query contract", () => {
  it("keeps the new API methods optional for older bridges", () => {
    const oldBridgeSeo: SiteIndexApi["seo"] = {
      summary: async () => ({ kpis: [], crawled_at: null, title_range: [30, 60] as [number, number], description_range: [120, 160] as [number, number] }),
      listIssues: async () => ({ rows: [], total: 0 }),
      listPages: async () => ({ rows: [], total: 0 }),
      listLinks: async () => ({ rows: [], total: 0 }),
      orphanPages: async () => [],
      getPage: async () => null,
      googleSiteUrl: async () => "https://www.google.com/",
      checkIndex: async () => ({ runId: "demo-run" }),
    };

    expect(oldBridgeSeo.pageBrief).toBeUndefined();
    expect(oldBridgeSeo.issueCandidates).toBeUndefined();
    expect(oldBridgeSeo.internalLinkContext).toBeUndefined();
  });

  it("registers all three API methods and CLI targets as pending", () => {
    for (const method of ["seo.pageBrief", "seo.issueCandidates", "seo.internalLinkContext"]) {
      expect(API_INVOKE_METHODS).toContain(method);
      expect(PENDING_HANDLERS).toContain(method);
    }
    expect(QUERY_TARGETS).toContain("seo-page-brief");
    expect(QUERY_TARGETS).toContain("seo-issue-candidates");
    expect(QUERY_TARGETS).toContain("seo-internal-link-context");
  });

  it("keeps query output serializable and leaves unindexed endpoint data null", () => {
    const page: SeoPageBrief["page"] = {
      url: "https://example-shop.test/page",
      page_type: "page",
      status_code: 200,
      title: "Demo page",
      title_length: 10,
      meta_description: null,
      description_length: 0,
      h1: null,
      h1_count: 0,
      canonical: null,
      canonical_status: "missing",
      robots_meta: null,
      x_robots_tag: null,
      indexable: true,
      in_sitemap: true,
      schema_types: [],
      word_count: null,
      last_crawled: "2026-11-12",
    };
    const context: ScenarioQueryResult<SeoInternalLinkContext> = {
      data: {
        page,
        incoming_links: [],
        outgoing_links: [{
          link: { from: page.url, to: "https://example-shop.test/unknown", anchor: "demo", to_type: "page" },
          target_page: null,
        }],
      },
      metadata: {
        sources: [{ kind: "seo_pages" }, { kind: "seo_links" }],
        collected_at: "2026-11-12T08:00:00.000Z",
        missing_fields: ["seo_links.target_page"],
        quality: "partial",
        anomalies: [{ code: "linked_page_not_indexed", severity: "warning", field: "seo_links.target_page", message: "链接目标未收录在当前 SEO 页面索引中。" }],
      },
    };

    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
  });
});
