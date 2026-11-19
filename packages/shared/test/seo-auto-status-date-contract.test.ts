import { describe, expect, it } from "vitest";
import type { SeoIssue } from "../src";

describe("SEO automatic status date contract", () => {
  it("keeps old issue rows valid and adds only an optional future transition date", () => {
    const legacy: SeoIssue = {
      url: "https://demo-shop.test/item", rule: "desc_missing", severity: "mid",
      detail: "虚构问题", status: "open", first_seen: "2026-11-18", last_seen: "2026-11-19",
    };
    const autoFixed: SeoIssue = { ...legacy, status: "fixed", auto_status_changed_on: "2026-11-19" };

    expect(legacy.auto_status_changed_on).toBeUndefined();
    expect(autoFixed).toMatchObject({
      status: "fixed", first_seen: legacy.first_seen, last_seen: legacy.last_seen,
      auto_status_changed_on: "2026-11-19",
    });
  });
});
