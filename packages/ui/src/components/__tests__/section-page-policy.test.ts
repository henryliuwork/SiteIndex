import { describe, expect, it } from "vitest";
import { checkSectionPageMetrics, type SectionPageMetrics } from "../../../visual/section-page-policy";

const compliant: SectionPageMetrics = {
  conditionalBannerVisible: false,
  tableHeaderTop: 190, visibleRowCapacity: 9, visibleTimeCount: 1,
  segmentGroupCount: 1, segmentCountBadgeCount: 0, relativeTimeCount: 0, horizontalScrollerCount: 0,
};

describe("section page measurable gates", () => {
  it("accepts all §3.5 limits and exempts overview without a table", () => {
    expect(checkSectionPageMetrics(compliant, 1280)).toEqual([]);
    expect(checkSectionPageMetrics({ ...compliant, tableHeaderTop: null, visibleRowCapacity: null }, 1280)).toEqual([]);
  });

  it("flags each new violation, including height only at 1280", () => {
    const bad = { conditionalBannerVisible: false, tableHeaderTop: 201, visibleRowCapacity: 8, visibleTimeCount: 2,
      segmentGroupCount: 2, segmentCountBadgeCount: 1, relativeTimeCount: 1, horizontalScrollerCount: 1 };
    expect(checkSectionPageMetrics(bad, 1280).map((finding) => finding.rule)).toEqual([
      "section-table-header-top", "section-visible-rows", "section-visible-time",
      "section-segment-groups", "section-segment-badges", "section-relative-time", "section-horizontal-scrollbar",
    ]);
    expect(checkSectionPageMetrics(bad, 1920).some((finding) => finding.rule === "section-table-header-top")).toBe(false);
    expect(checkSectionPageMetrics({ ...bad, conditionalBannerVisible: true }, 1280).some((finding) => finding.rule === "section-table-header-top")).toBe(false);
  });

  it("records existing five-page findings without tolerating a regression", () => {
    const bad = { ...compliant, tableHeaderTop: 260, visibleRowCapacity: 6 };
    const baseline = { tableHeaderTop: 270, visibleRowCapacity: 5 };
    expect(checkSectionPageMetrics(bad, 1280, baseline).every((finding) => finding.legacy)).toBe(true);
    expect(checkSectionPageMetrics({ ...bad, tableHeaderTop: 271 }, 1280, baseline)[0]?.legacy).toBe(false);
    expect(checkSectionPageMetrics({ ...bad, visibleRowCapacity: 4 }, 1280, baseline)[1]?.legacy).toBe(false);
  });
});
