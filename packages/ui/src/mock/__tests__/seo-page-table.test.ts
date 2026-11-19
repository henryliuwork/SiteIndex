import { describe, expect, it } from "vitest";
import { mockSeoPageRows } from "../seo-page-table";

describe("SEO mock 页面聚合", () => {
  it("默认在全量页面上按高优先级问题排序再分页，目标仅含真实 open 问题", () => {
    const result = mockSeoPageRows("demo", { page: 1, pageSize: 1 });
    expect(result.total).toBeGreaterThan(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.open_issue_counts.high).toBe(1);
    expect(result.rows[0]?.open_issue_targets).toEqual([{ url: result.rows[0]?.url, rule: "http_4xx" }]);
    expect(result.summary.open_pages).toBeGreaterThan(0);
  });

  it("旧 rule/status 深链交集只返回命中页面，不改全站摘要", () => {
    const all = mockSeoPageRows("demo", { page: 1, pageSize: 0 });
    const filtered = mockSeoPageRows("demo", { page: 1, pageSize: 0, filters: { rules: ["desc_missing"], status: "open" } });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]?.open_issue_counts.mid).toBe(1);
    expect(filtered.summary).toEqual(all.summary);
  });

  it("空结果不伪造页面或问题", () => {
    const result = mockSeoPageRows("demo", { page: 1, pageSize: 0, filters: { page_type: "home", rules: ["http_5xx"] } });
    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
  });
});
