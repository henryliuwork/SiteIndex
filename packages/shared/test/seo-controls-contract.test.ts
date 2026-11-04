import { describe, expect, it } from "vitest";
import { API_INVOKE_METHODS, PENDING_HANDLERS, SEO_RULE_LABELS } from "../src";

describe("SEO and project control contract", () => {
  it("registers every optional method as pending until the bridge implements it", () => {
    const methods = ["projects.remove", "seo.setIssueStatus", "seo.setRuleIgnored",
      "schedule.verify", "schedule.listOrphans", "schedule.removeOrphan"];
    for (const method of methods) {
      expect(API_INVOKE_METHODS).toContain(method);
      expect(PENDING_HANDLERS).toContain(method);
    }
  });

  it("exports Chinese labels for current and legacy SEO rule keys", () => {
    expect(SEO_RULE_LABELS.desc_duplicate).toBe("Description 重复");
    expect(SEO_RULE_LABELS.desc_missing).toBe("Meta description 缺失");
    expect(SEO_RULE_LABELS.hreflang_invalid).toBe("hreflang 异常");
    expect(SEO_RULE_LABELS.title_length).toBe("Title 长度异常");
  });
});
