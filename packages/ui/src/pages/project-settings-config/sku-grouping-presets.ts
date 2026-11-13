import type { SkuGroupingRule } from "@siteindex/shared";

export const trailingNumberPattern = "^(.+?)\\d{1,3}$";
export const recommendedSkuGroupingPattern = "^(.+[A-Za-z])\\d{2}[A-Za-z]{0,3}$";
export const cpParentSkuPattern = "^(.+CP).+$";

export const skuGroupingPresetOptions = [
  { value: "recommended-two-digit", label: "父 SKU + 两位序号（可带 1–3 位字母后缀，推荐）" },
  { value: "cp-parent-any-suffix", label: "父 SKU 以 CP 结尾（后接任意非空后缀）" },
  { value: "trailing-number", label: "移除末尾数字序号" },
  { value: "suffix", label: "移除固定后缀" },
  { value: "separator", label: "按分隔符归组" },
  { value: "custom-regex", label: "自定义正则" },
] as const;

export type SkuGroupingPreset = typeof skuGroupingPresetOptions[number]["value"];

const customRegexDefault = "^(.+?)-[A-Z]$";

export function skuGroupingPresetForRule(rule: SkuGroupingRule): SkuGroupingPreset {
  if (rule.type === "suffix") return "suffix";
  if (rule.type === "separator") return "separator";
  if (rule.value === cpParentSkuPattern) return "cp-parent-any-suffix";
  if (rule.value === recommendedSkuGroupingPattern) return "recommended-two-digit";
  return rule.value === trailingNumberPattern ? "trailing-number" : "custom-regex";
}

export function skuGroupingRuleForPreset(preset: SkuGroupingPreset, current: SkuGroupingRule): SkuGroupingRule {
  if (preset === "recommended-two-digit") return { type: "regex", value: recommendedSkuGroupingPattern };
  if (preset === "cp-parent-any-suffix") return { type: "regex", value: cpParentSkuPattern };
  if (preset === "trailing-number") return { type: "regex", value: trailingNumberPattern };
  if (preset === "suffix") return current.type === "suffix" ? current : { type: "suffix", value: "-G" };
  if (preset === "separator") return current.type === "separator" ? current : { type: "separator", value: "-" };
  return current.type === "regex" && current.value !== recommendedSkuGroupingPattern && current.value !== trailingNumberPattern
    ? current
    : { type: "regex", value: customRegexDefault };
}

export function skuGroupingExample(rule: SkuGroupingRule): string {
  if (rule.type === "regex" && rule.value === cpParentSkuPattern) {
    return "DEMO001CP1 → DEMO001CP；DEMO001CP01BLUE → DEMO001CP";
  }
  if (rule.type === "suffix") {
    return rule.value ? `DEMO001A${rule.value} → DEMO001A` : "请填写固定后缀";
  }
  if (rule.type === "separator") {
    return rule.value ? `DEMO001A${rule.value}01 → DEMO001A` : "请填写分隔符";
  }
  const samples = ["DEMO001CP01", "DEMO001CP01B", "DEMO001CP1A01", "DEMO001CP", "DEMO001"];
  try {
    const expression = new RegExp(rule.value);
    for (const sku of samples) {
      const match = expression.exec(sku);
      if (!match) continue;
      return match[1] ? `${sku} → ${match[1]}` : `${sku} → 正则需包含父 SKU 捕获组`;
    }
    return `${samples[0]} → 当前规则未匹配示例`;
  } catch {
    return "正则格式无效，暂无法生成示例";
  }
}
