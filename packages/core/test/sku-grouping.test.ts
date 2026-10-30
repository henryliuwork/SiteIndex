import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SkuGroupingRule } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { groupSkuIds, previewSkuGrouping, SkuGroupingRuleError } from "../src/inventory/sku-grouping";

const GROUPING_FIXTURE = path.resolve(process.cwd(), "fixtures/sku-grouping/193-skus.json");

describe("deterministic SKU grouping", () => {
  it("removes a literal suffix and de-duplicates repeated feed IDs", () => {
    const result = groupSkuIds(["MUG-G", "MUG-G", "OTHER"], { type: "suffix", value: "-G" });
    expect(result.groups).toEqual([{ parent: "MUG", children: ["MUG-G"] }]);
    expect(result.unmatched).toEqual(["OTHER"]);
  });

  it("groups on the last configured separator", () => {
    const result = groupSkuIds(["FAM-B-RED", "FAM-A-BLUE", "FAM-A-RED"], { type: "separator", value: "-" });
    expect(result.groups).toEqual([
      { parent: "FAM-A", children: ["FAM-A-BLUE", "FAM-A-RED"] },
      { parent: "FAM-B", children: ["FAM-B-RED"] },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("uses the first regex capture and produces the same order for any input order", () => {
    const rule: SkuGroupingRule = { type: "regex", value: "^(.+?)-([A-Z]+)$" };
    const input = ["Z-RED", "A-BLUE", "A-RED", "Z-BLUE"];
    const expected = groupSkuIds(input, rule);
    expect(groupSkuIds([...input].reverse(), rule)).toEqual(expected);
    expect(groupSkuIds(input, rule)).toEqual(expected);
    expect(expected.groups).toEqual([
      { parent: "A", children: ["A-BLUE", "A-RED"] },
      { parent: "Z", children: ["Z-BLUE", "Z-RED"] },
    ]);
  });

  it("keeps a single-child relationship without creating a stock entity", () => {
    const result = groupSkuIds(["SOLO-G"], { type: "suffix", value: "-G" });
    expect(result.groups).toEqual([{ parent: "SOLO", children: ["SOLO-G"] }]);
    expect([...result.parentByChild]).toEqual([["SOLO-G", "SOLO"]]);
    expect(result.unmatched).toEqual([]);
  });

  it("counts empty and unmatched IDs without making a group", () => {
    expect(previewSkuGrouping(["", "PLAIN", "NO-SUFFIX"], { type: "suffix", value: "-G" })).toEqual({
      parents: 0,
      children: 0,
      samples: [],
      unmatched: 3,
    });
  });

  it("treats a derived parent that already exists as a real SKU as a collision", () => {
    const result = groupSkuIds(["BASE-RED", "BASE-BLUE", "BASE"], { type: "separator", value: "-" });
    expect(result.groups).toEqual([]);
    expect(result.unmatched).toEqual(["BASE", "BASE-BLUE", "BASE-RED"]);
  });

  it("rejects empty values and malformed regular expressions", () => {
    expect(() => groupSkuIds(["SKU-A"], { type: "separator", value: " " })).toThrow(SkuGroupingRuleError);
    expect(() => groupSkuIds(["SKU-A"], { type: "regex", value: "[" })).toThrow("正则表达式语法无效。");
  });

  it("groups a fictional 193-SKU feed deterministically and bounds preview samples", async () => {
    const fixture = JSON.parse(await readFile(GROUPING_FIXTURE, "utf8")) as { skus: string[] };
    expect(fixture.skus).toHaveLength(193);
    const rule: SkuGroupingRule = { type: "regex", value: "^(.+)-[A-Z]+$" };
    const preview = previewSkuGrouping(fixture.skus, rule);
    expect(preview).toMatchObject({ parents: 64, children: 192, unmatched: 1 });
    expect(preview.samples).toHaveLength(20);
    expect(preview.samples[0]).toEqual({
      parent: "SAMPLE-001",
      children: ["SAMPLE-001-BLUE", "SAMPLE-001-GREEN", "SAMPLE-001-RED"],
    });
    expect(previewSkuGrouping([...fixture.skus].reverse(), rule)).toEqual(preview);
  });
});
