import { describe, expect, it } from "vitest";
import { checkFrameMetrics, type FrameBaseline, type FrameMetrics } from "../frame-policy";

const baseline: FrameBaseline = { version: 1, legacyRoutes: { legacy: "project" } };
const project: FrameMetrics = {
  kind: "project", headerOffset: 0, headerHeight: 48, globalPaddingTop: 0, bodyStart: 16,
  buttonHeights: [32, 32], buttonGaps: [12], documentScroll: false, contentScroll: false, bodyScroll: false,
  toolbarControlHeights: [32, 32], toolbarGaps: [8], selectedFilterGaps: [12, 12],
  tables: [{ id: "products.merged", firstHeader: "SKU", hasSkuHeader: true }], domainInProjectHeader: false,
};

describe("v0.8 PageFrame gate", () => {
  it("reports a legacy route explicitly and rejects an unlisted route", () => {
    expect(checkFrameMetrics("legacy", "project", true, { ...project, kind: null }, baseline)).toEqual({ status: "legacy", findings: [] });
    expect(checkFrameMetrics("new-route", "project", true, { ...project, kind: null }, baseline).findings[0]?.rule).toBe("frame-missing");
  });

  it("requires a migrated route to leave the legacy baseline", () => {
    expect(checkFrameMetrics("legacy", "project", true, project, baseline).findings[0]?.rule).toBe("frame-stale-baseline");
    expect(checkFrameMetrics("new-route", "project", true, project, baseline)).toEqual({ status: "strict", findings: [] });
  });

  it("fails all project header, scroll, toolbar, filter and SKU regressions", () => {
    const broken: FrameMetrics = { ...project, headerOffset: 3, headerHeight: 44, bodyStart: 10,
      buttonHeights: [28], buttonGaps: [4], documentScroll: true, toolbarControlHeights: [34],
      toolbarGaps: [4], selectedFilterGaps: [8], tables: [{ id: "products.merged", firstHeader: "名称", hasSkuHeader: false }], domainInProjectHeader: true };
    const rules = checkFrameMetrics("new-route", "project", true, broken, baseline).findings.map((finding) => finding.rule);
    expect(rules).toEqual(expect.arrayContaining([
      "project-header-top", "project-header-height", "project-header-domain", "project-header-button-height",
      "project-header-button-gap", "frame-body-start", "frame-table-scroll", "toolbar-control-height",
      "toolbar-control-gap", "selected-filter-gap", "sku-first-column",
    ]));
  });

  it("fails when a known SKU table has no SKU column at all, including the variant drawer", () => {
    const noSku: FrameMetrics = { ...project, tables: [
      { id: "products.merged", firstHeader: "产品名称", hasSkuHeader: false },
      { id: "products.variant-stock", firstHeader: "变体名称", hasSkuHeader: false },
    ] };
    expect(checkFrameMetrics("products", "project", true, noSku, baseline).findings.map((finding) => finding.rule))
      .toEqual(["sku-first-column", "sku-first-column"]);
    expect(checkFrameMetrics("edm", "project", true, { ...project, tables: [{ id: "edm.images", firstHeader: "图片", hasSkuHeader: false }] }, baseline)
      .findings.map((finding) => finding.rule)).toEqual(["sku-first-column"]);
  });

  it("checks global title geometry without requiring a project header", () => {
    const global: FrameMetrics = { ...project, kind: "global", headerHeight: 56, globalPaddingTop: 24 };
    expect(checkFrameMetrics("settings", "global", false, global, baseline).findings).toEqual([]);
    expect(checkFrameMetrics("settings", "global", false, { ...global, globalPaddingTop: 16 }, baseline).findings[0]?.rule).toBe("global-title-padding");
  });
});
