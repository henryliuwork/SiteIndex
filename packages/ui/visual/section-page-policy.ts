export const SECTION_PAGE_NAMES = ["seo", "content", "edm", "products", "overview"] as const;

export interface SectionPageMetrics {
  conditionalBannerVisible: boolean;
  tableHeaderTop: number | null;
  visibleRowCapacity: number | null;
  visibleTimeCount: number;
  segmentGroupCount: number;
  segmentCountBadgeCount: number;
  relativeTimeCount: number;
  horizontalScrollerCount: number;
}

export interface SectionPageBaseline {
  version: 1;
  checks: Record<string, Partial<SectionPageMetrics>>;
}

export interface SectionPageFinding { rule: string; actual: number; limit: number; legacy: boolean }

export function checkSectionPageMetrics(
  metrics: SectionPageMetrics,
  viewportWidth: number,
  baseline: Partial<SectionPageMetrics> = {},
): SectionPageFinding[] {
  const findings: SectionPageFinding[] = [];
  const max = (rule: string, key: keyof SectionPageMetrics, actual: number | null, limit: number) => {
    if (actual == null || actual <= limit) return;
    const old = baseline[key];
    findings.push({ rule, actual, limit, legacy: typeof old === "number" && actual <= old });
  };
  if (viewportWidth === 1280 && !metrics.conditionalBannerVisible) {
    max("section-table-header-top", "tableHeaderTop", metrics.tableHeaderTop, 200);
    if (metrics.visibleRowCapacity != null && metrics.visibleRowCapacity < 9) {
      const old = baseline.visibleRowCapacity;
      findings.push({ rule: "section-visible-rows", actual: metrics.visibleRowCapacity, limit: 9,
        legacy: typeof old === "number" && metrics.visibleRowCapacity >= old });
    }
  }
  max("section-visible-time", "visibleTimeCount", metrics.visibleTimeCount, 1);
  max("section-segment-groups", "segmentGroupCount", metrics.segmentGroupCount, 1);
  max("section-segment-badges", "segmentCountBadgeCount", metrics.segmentCountBadgeCount, 0);
  max("section-relative-time", "relativeTimeCount", metrics.relativeTimeCount, 0);
  max("section-horizontal-scrollbar", "horizontalScrollerCount", metrics.horizontalScrollerCount, 0);
  return findings;
}
