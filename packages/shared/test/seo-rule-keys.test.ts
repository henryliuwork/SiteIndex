import { describe, expect, it } from "vitest";
import type { SeoIssueFilters, SeoRule } from "../src";

describe("SEO rule key contract", () => {
  it("declares the stable keys needed for length, hreflang and URL checks", () => {
    const rules: readonly SeoRule[] = [
      "title_too_short",
      "title_too_long",
      "desc_too_short",
      "desc_too_long",
      "hreflang_invalid",
      "url_too_long",
    ];
    const filters: SeoIssueFilters = { rules: [...rules] };

    expect(filters.rules).toEqual(rules);
  });
});
