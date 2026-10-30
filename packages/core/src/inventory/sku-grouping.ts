import type { SkuGroupingPreview, SkuGroupingRule } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

const MAX_PREVIEW_GROUPS = 20;
const MAX_PREVIEW_CHILDREN = 20;

export interface SkuGroup {
  parent: string;
  children: string[];
}

export interface SkuGroupingResult {
  groups: SkuGroup[];
  unmatched: string[];
  parentByChild: ReadonlyMap<string, string>;
}

export class SkuGroupingRuleError extends Error {
  readonly code = "CONFIG_INVALID" as const;

  readonly detail: string;

  constructor(message: string) {
    super(`SKU 分组规则无效：${message}`);
    this.name = "SkuGroupingRuleError";
    this.detail = message;
  }
}

type NormalizedRule =
  | { type: "suffix" | "separator"; value: string }
  | { type: "regex"; value: string; expression: RegExp };

function normalizeRule(input: unknown): NormalizedRule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SkuGroupingRuleError("规则必须包含类型和值。");
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.type !== "suffix" && candidate.type !== "separator" && candidate.type !== "regex") {
    throw new SkuGroupingRuleError("规则类型必须是 suffix、separator 或 regex。");
  }
  if (typeof candidate.value !== "string" || candidate.value.trim().length === 0) {
    throw new SkuGroupingRuleError("规则值不能为空。");
  }
  if (candidate.type !== "regex") return { type: candidate.type, value: candidate.value };
  try {
    return { type: "regex", value: candidate.value, expression: new RegExp(candidate.value) };
  } catch {
    throw new SkuGroupingRuleError("正则表达式语法无效。");
  }
}

function deriveParentSku(sku: string, rule: NormalizedRule): string | null {
  if (!sku.trim()) return null;
  let parent: string | undefined;
  if (rule.type === "suffix") {
    if (!sku.endsWith(rule.value) || sku.length <= rule.value.length) return null;
    parent = sku.slice(0, -rule.value.length);
  } else if (rule.type === "separator") {
    const separatorIndex = sku.lastIndexOf(rule.value);
    if (separatorIndex <= 0) return null;
    parent = sku.slice(0, separatorIndex);
  } else if (rule.type === "regex") {
    const match = rule.expression.exec(sku);
    parent = match?.[1];
  }
  if (!parent?.trim() || parent === sku) return null;
  return parent;
}

/**
 * Groups feed SKUs using the same suffix, last-separator and first-regex-capture
 * semantics as the project settings preview. A parent that is itself a feed
 * SKU is treated as a collision, so no synthetic parent can shadow real stock.
 */
export function groupSkuIds(skus: readonly string[], inputRule: SkuGroupingRule): SkuGroupingResult {
  const rule = normalizeRule(inputRule);
  const uniqueSkus = [...new Set(skus)].sort(compareKeys);
  const skuSet = new Set(uniqueSkus);
  const candidates = new Map<string, string[]>();

  for (const sku of uniqueSkus) {
    const parent = deriveParentSku(sku, rule);
    if (!parent) continue;
    const children = candidates.get(parent) ?? [];
    children.push(sku);
    candidates.set(parent, children);
  }

  const groups = [...candidates]
    .filter(([parent]) => !skuSet.has(parent))
    .map(([parent, children]) => ({ parent, children: children.sort(compareKeys) }))
    .sort((left, right) => compareKeys(left.parent, right.parent));
  const parentByChild = new Map<string, string>();
  for (const group of groups) for (const child of group.children) parentByChild.set(child, group.parent);
  const unmatched = uniqueSkus.filter((sku) => !parentByChild.has(sku));

  return { groups, unmatched, parentByChild };
}

export function previewSkuGrouping(skus: readonly string[], rule: SkuGroupingRule): SkuGroupingPreview {
  const result = groupSkuIds(skus, rule);
  const children = result.groups.reduce((count, group) => count + group.children.length, 0);
  return {
    parents: result.groups.length,
    children,
    samples: result.groups.slice(0, MAX_PREVIEW_GROUPS).map(({ parent, children: groupChildren }) => ({
      parent,
      children: groupChildren.slice(0, MAX_PREVIEW_CHILDREN),
    })),
    unmatched: result.unmatched.length,
  };
}
