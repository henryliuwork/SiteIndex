import { describe, expect, it } from "vitest";
// @vitest-environment jsdom
import { rowOrderFinding, sortHeaderXPath } from "./t7-inspect";

describe("T7 sortable table evidence", () => {
  it("accepts distinct ascending and descending row orders", () => {
    expect(rowOrderFinding("表", "列", ["a", "b"], ["b", "a"])).toBeNull();
  });

  it("rejects an empty, single-row or equal-value fixture", () => {
    expect(rowOrderFinding("表", "列", [], [])?.message).toContain("至少两行");
    expect(rowOrderFinding("表", "列", ["a"], ["a"])?.message).toContain("至少两行");
    expect(rowOrderFinding("表", "列", ["a", "b"], ["a", "b"])?.message).toContain("行序相同");
  });

  it("rejects duplicate row identifiers", () => {
    expect(rowOrderFinding("表", "列", ["a", "a"], ["a", "a"])?.message).toContain("重复行 ID");
  });

  it("finds the sortable th around a help-tooltip wrapper", () => {
    document.body.innerHTML = '<table><thead><tr><th aria-sort="ascending"><span class="si-table-heading"><button class="si-sort-button">30 天在线率</button><span>i</span></span></th></tr></thead></table>';
    const button = document.querySelector(".si-sort-button");
    expect(document.evaluate(sortHeaderXPath("ascending"), button, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue).toBe(button?.closest("th"));
  });
});
