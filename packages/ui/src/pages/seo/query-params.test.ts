import { describe, expect, it } from "vitest";
import { issueFiltersFromSearchParams } from "./query-params";

describe("SEO 问题 URL 筛选", () => {
  it("从 rule 和 status 参数恢复初始筛选", () => {
    expect(issueFiltersFromSearchParams(new URLSearchParams("rule=desc_duplicate&status=open"))).toEqual({
      rules: ["desc_duplicate"], status: "open",
    });
  });

  it("忽略未知状态并保留有效的问题类型", () => {
    expect(issueFiltersFromSearchParams(new URLSearchParams("rule=schema_missing&status=unknown"))).toEqual({
      rules: ["schema_missing"],
    });
  });

  it("支持多个规则参数并去重", () => {
    expect(issueFiltersFromSearchParams(new URLSearchParams("rule=desc_duplicate&rule=schema_missing&rule=desc_duplicate")))
      .toEqual({ rules: ["desc_duplicate", "schema_missing"] });
  });
});
