import type { SeoIssue, SeoRule, SeoSummary, Severity } from "@siteindex/shared";

interface SeoRuleDefinition {
  label: string;
  severity: Severity;
}

const SEO_RULE_DEFINITIONS: Record<SeoRule, SeoRuleDefinition> = {
  http_4xx: { label: "页面 4xx", severity: "high" },
  http_5xx: { label: "页面 5xx", severity: "high" },
  redirect_chain: { label: "重定向链", severity: "mid" },
  noindex: { label: "noindex", severity: "low" },
  canonical_other: { label: "Canonical 指向其他页面", severity: "mid" },
  canonical_missing: { label: "Canonical 缺失", severity: "low" },
  not_in_sitemap: { label: "未在 Sitemap 中", severity: "low" },
  title_missing: { label: "Title 缺失", severity: "mid" },
  title_too_short: { label: "Title 过短", severity: "low" },
  title_too_long: { label: "Title 过长", severity: "low" },
  desc_missing: { label: "Description 缺失", severity: "mid" },
  desc_too_short: { label: "Description 过短", severity: "low" },
  desc_too_long: { label: "Description 过长", severity: "low" },
  title_length: { label: "Title 长度异常", severity: "low" },
  desc_length: { label: "Description 长度异常", severity: "low" },
  title_duplicate: { label: "Title 重复", severity: "mid" },
  desc_duplicate: { label: "Description 重复", severity: "mid" },
  h1_missing: { label: "H1 缺失", severity: "low" },
  h1_multiple: { label: "H1 多个", severity: "low" },
  schema_missing: { label: "Schema 缺失", severity: "mid" },
  schema_error: { label: "Schema 错误", severity: "mid" },
  img_alt_missing: { label: "图片 Alt 缺失", severity: "low" },
  hreflang_invalid: { label: "hreflang 异常", severity: "mid" },
  url_too_long: { label: "URL 过长", severity: "low" },
  thin_content: { label: "内容过短", severity: "low" },
  orphan: { label: "孤立页面", severity: "low" },
};

function isSeoRule(value: string): value is SeoRule {
  return Object.hasOwn(SEO_RULE_DEFINITIONS, value);
}

/** Return stable counts and labels for every supported rule, including zero-count rules. */
export function buildSeoIssueCounts(issues: readonly SeoIssue[]): NonNullable<SeoSummary["issue_counts"]> {
  const rules = Object.keys(SEO_RULE_DEFINITIONS).filter(isSeoRule);
  const counts = new Map<SeoRule, number>(rules.map((rule) => [rule, 0]));
  for (const issue of issues) counts.set(issue.rule, (counts.get(issue.rule) ?? 0) + 1);
  return rules.map((rule) => ({
    rule,
    label: SEO_RULE_DEFINITIONS[rule].label,
    severity: SEO_RULE_DEFINITIONS[rule].severity,
    count: counts.get(rule) ?? 0,
  }));
}