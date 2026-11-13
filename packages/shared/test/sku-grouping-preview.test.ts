import { describe, expect, it } from "vitest";
import type { SkuGroupingPreview } from "../src/api";
import type { SkuGroupingRule } from "../src/models";

describe("SKU grouping preview contract", () => {
  it("preserves legacy regex rules and represents an explicit real feed parent", () => {
    const legacy: SkuGroupingRule = { type: "regex", value: "^(.+CP).+$" };
    const realParent: SkuGroupingRule = { ...legacy, parent_source: "feed" };
    const derived: SkuGroupingRule = { ...legacy, parent_source: "derived" };

    expect(legacy).not.toHaveProperty("parent_source");
    expect(JSON.parse(JSON.stringify(realParent))).toEqual({
      type: "regex", value: "^(.+CP).+$", parent_source: "feed",
    });
    expect(derived.parent_source).toBe("derived");
  });

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
