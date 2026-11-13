import { describe, expect, it } from "vitest";
import { cpParentSkuPattern, recommendedSkuGroupingPattern, skuGroupingExample, skuGroupingPresetForRule, skuGroupingPresetOptions, skuGroupingRuleForPreset, trailingNumberPattern } from "./sku-grouping-presets";

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

  it("CP 预设匹配不同长度和字母后缀，但不匹配父 SKU 本身", () => {
    const expression = new RegExp(cpParentSkuPattern);
    const cases: [string, string][] = [
      ["DEMO001CP1", "DEMO001CP"],
      ["DEMO001CP0012", "DEMO001CP"],
      ["DEMO001CP1A", "DEMO001CP"],
      ["DEMO001CP01BLUE", "DEMO001CP"],
    ];

    for (const [sku, parent] of cases) {
      expect(expression.exec(sku)?.[1], sku).toBe(parent);
    }
    expect(expression.test("DEMO001CP")).toBe(false);
    expect(expression.test("DEMO001AB12")).toBe(false);
  });

  it("默认推荐新预设，同时保留旧规则及其各自的即时示例", () => {
    expect(skuGroupingRuleForPreset("recommended-two-digit", { type: "regex", value: "custom" })).toEqual({ type: "regex", value: recommendedSkuGroupingPattern });
    expect(skuGroupingPresetForRule({ type: "regex", value: recommendedSkuGroupingPattern })).toBe("recommended-two-digit");
    expect(skuGroupingPresetForRule({ type: "regex", value: trailingNumberPattern })).toBe("trailing-number");
    expect(skuGroupingExample({ type: "regex", value: recommendedSkuGroupingPattern })).toBe("DEMO001CP01 → DEMO001CP");
    const cpParentRule = { type: "regex", value: cpParentSkuPattern, parent_source: "feed" } as const;
    expect(skuGroupingRuleForPreset("cp-parent-any-suffix", { type: "regex", value: "custom" })).toEqual(cpParentRule);
    expect(skuGroupingPresetForRule(cpParentRule)).toBe("cp-parent-any-suffix");
    expect(skuGroupingPresetForRule({ type: "regex", value: cpParentSkuPattern })).toBe("custom-regex");
    expect(skuGroupingExample({ type: "regex", value: cpParentSkuPattern })).toBe("DEMO001CP1 → DEMO001CP；DEMO001CP01BLUE → DEMO001CP");
    expect(skuGroupingPresetOptions.some((option) => option.value === "custom-regex")).toBe(true);
  });
});
