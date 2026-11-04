import { describe, expect, it } from "vitest";
import { searchTextFromSearchParams, seoRouteFiltersFromSearchParams, updateSeoSearchParams } from "./query-params";

describe("SEO 查询参数", () => {
  it("恢复问题规则、状态和严重级别", () => {
    expect(seoRouteFiltersFromSearchParams(new URLSearchParams("rule=desc_duplicate&status=open&severity=high"))).toEqual({
      view: "issues", issues: { rules: ["desc_duplicate"], status: "open", severity: "high" }, pages: {},
    });
  });

  it("忽略无效筛选值", () => {
    expect(seoRouteFiltersFromSearchParams(new URLSearchParams("rule=schema_missing&status=unknown&severity=critical"))).toEqual({
      view: "issues", issues: { rules: ["schema_missing"] }, pages: {},
    });
  });

  it("支持重复规则参数并去重", () => {
    expect(seoRouteFiltersFromSearchParams(new URLSearchParams("rule=desc_duplicate&rule=schema_missing&rule=desc_duplicate"))
      .issues.rules).toEqual(["desc_duplicate", "schema_missing"]);
  });

  it("恢复页面视图的页面类型、收录状态和搜索词", () => {
    const params = new URLSearchParams("view=pages&page_type=blog&indexed=unchecked&q=article");
    expect(seoRouteFiltersFromSearchParams(params)).toEqual({ view: "pages", issues: {}, pages: { page_type: "blog", indexed: "unchecked" } });
    expect(searchTextFromSearchParams(params)).toBe("article");
  });

  it("更新 URL 中的筛选条件并保留其他参数", () => {
    expect(updateSeoSearchParams(new URLSearchParams("mock=error&rule=old"), {
      rule: ["desc_duplicate", "schema_missing"], severity: "high", status: null,
    }).toString()).toBe("mock=error&rule=desc_duplicate&rule=schema_missing&severity=high");
  });
});
