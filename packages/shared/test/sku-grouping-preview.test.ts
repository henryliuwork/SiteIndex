import { describe, expect, it } from "vitest";
import type { SkuGroupingPreview } from "../src/api";

describe("SKU grouping preview contract", () => {
  it("keeps collision reports optional for existing consumers", () => {
    const legacyPreview: SkuGroupingPreview = {
      parents: 0,
      children: 0,
      samples: [],
      unmatched: 3,
    };
    const previewWithReport: SkuGroupingPreview = {
      ...legacyPreview,
      collisions: [{ parent: "BASE", children: ["BASE-BLUE", "BASE-RED"] }],
    };

    expect(legacyPreview).not.toHaveProperty("collisions");
    expect(previewWithReport.collisions).toEqual([
      { parent: "BASE", children: ["BASE-BLUE", "BASE-RED"] },
    ]);
  });
});
