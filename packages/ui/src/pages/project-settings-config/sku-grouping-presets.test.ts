import { describe, expect, it } from "vitest";
import { recommendedSkuGroupingPattern, skuGroupingExample, skuGroupingPresetForRule, skuGroupingRuleForPreset, trailingNumberPattern } from "./sku-grouping-presets";

describe("SKU 分组预设", () => {
  it("保留旧规则并将指定的新规则标为推荐", () => {
    expect(trailingNumberPattern).toBe("^(.+?)\\d{1,3}$");
    expect(recommendedSkuGroupingPattern).toBe("^(.+[A-Za-z])\\d{2}[A-Za-z]{0,3}$");
  });

  it("推荐正则将末尾两位序号和可选字母后缀映射到父 SKU", () => {
    const cases: [string, string][] = [
      ["DEMO001CP01", "DEMO001CP"],
      ["DEMO001CP01B", "DEMO001CP"],
      ["DEMO001CP1A01", "DEMO001CP1A"],
      ["DEMO001CP1A01B", "DEMO001CP1A"],
    ];
    const expression = new RegExp(recommendedSkuGroupingPattern);

    for (const [sku, parent] of cases) {
      expect(expression.exec(sku)?.[1], sku).toBe(parent);
    }
  });

  it("推荐正则不匹配父项、普通数字 SKU 或末尾三位序号", () => {
    const expression = new RegExp(recommendedSkuGroupingPattern);

    for (const sku of ["DEMO001CP", "DEMO001", "DEMO001CP101"]) {
      expect(expression.test(sku), sku).toBe(false);
    }
  });

  it("默认推荐新预设，同时保留旧规则及其各自的即时示例", () => {
    expect(skuGroupingRuleForPreset("recommended-two-digit", { type: "regex", value: "custom" })).toEqual({ type: "regex", value: recommendedSkuGroupingPattern });
    expect(skuGroupingPresetForRule({ type: "regex", value: recommendedSkuGroupingPattern })).toBe("recommended-two-digit");
    expect(skuGroupingPresetForRule({ type: "regex", value: trailingNumberPattern })).toBe("trailing-number");
    expect(skuGroupingExample({ type: "regex", value: recommendedSkuGroupingPattern })).toBe("DEMO001CP01 → DEMO001CP");
  });
});
