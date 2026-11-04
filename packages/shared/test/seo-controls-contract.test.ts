import { describe, expect, it } from "vitest";
import { API_INVOKE_METHODS, PENDING_HANDLERS, SEO_RULE_LABELS } from "../src";

describe("SEO and project control contract", () => {
  it("removes methods with Desktop handlers from pending while retaining unimplemented optional methods", () => {
    const implementedMethods = ["seo.setIssueStatus", "seo.setRuleIgnored", "schedule.verify"];
    const pendingMethods = ["projects.remove", "schedule.listOrphans", "schedule.removeOrphan"];

    for (const method of implementedMethods) {
      expect(API_INVOKE_METHODS).toContain(method);
      expect(PENDING_HANDLERS).not.toContain(method);
    }
    for (const method of pendingMethods) {
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
