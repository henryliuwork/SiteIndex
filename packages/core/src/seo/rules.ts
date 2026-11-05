import { SEO_RULE_LABELS, type SeoIssue, type SeoRule, type SeoRuleSetting, type SeoSummary, type Severity } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

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

const SEO_RULE_DESCRIPTIONS: Record<SeoRule, string> = {
  http_4xx: "页面请求返回 4xx 状态码。",
  http_5xx: "页面请求返回 5xx 状态码。",
  redirect_chain: "页面请求经过两次或更多次跳转。",
  noindex: "页面 robots meta 或 X-Robots-Tag 指示不收录。",
  canonical_other: "页面 canonical 地址指向另一个 URL。",
  canonical_missing: "页面没有 canonical 标签。",
  not_in_sitemap: "页面有站内链接，但未出现在 Sitemap 中。",
  title_missing: "页面缺少 Title。",
  title_too_short: "Title 短于 site.json 中设置的最小长度。",
  title_too_long: "Title 长于 site.json 中设置的最大长度。",
  desc_missing: "页面缺少 Meta description。",
  desc_too_short: "Meta description 短于 site.json 中设置的最小长度。",
  desc_too_long: "Meta description 长于 site.json 中设置的最大长度。",
  title_length: "兼容旧规则：Title 超出 site.json 配置的长度范围。",
  desc_length: "兼容旧规则：Meta description 超出 site.json 配置的长度范围。",
  title_duplicate: "多个页面使用了相同的 Title。",
  desc_duplicate: "多个页面使用了相同的 Meta description。",
  h1_missing: "页面缺少 H1 标题。",
  h1_multiple: "页面包含多个 H1 标题。",
  schema_missing: "产品页缺少 Product Schema，或博客页缺少 Article/BlogPosting Schema。",
  schema_error: "页面 Schema 缺少必填属性或结构无效。",
  img_alt_missing: "页面中有图片缺少 alt 文本。",
  hreflang_invalid: "页面 hreflang 标签存在无效语言代码或重复语言。",
  url_too_long: "页面 URL 超过建议长度。",
  thin_content: "博客正文少于 300 词，或分类页介绍少于 50 词。",
  orphan: "页面没有来自站内其他页面的入链。",
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

/** Returns deterministic settings metadata and the active ignore state for every supported SEO rule. */
export function buildSeoRuleSettings(
  issues: readonly SeoIssue[],
  ignoreRules: readonly { rule: SeoRule; url?: string }[],
): SeoRuleSetting[] {
  const rules = Object.keys(SEO_RULE_DEFINITIONS).filter(isSeoRule).sort(compareKeys);
  const pendingCounts = new Map<SeoRule, number>(rules.map((rule) => [rule, 0]));
  for (const issue of issues) {
    if (issue.status === "open") pendingCounts.set(issue.rule, (pendingCounts.get(issue.rule) ?? 0) + 1);
  }

  return rules.map((rule) => {
    const configured = ignoreRules.filter((entry) => entry.rule === rule);
    const ignoredUrls = [...new Set(configured.flatMap((entry) => entry.url ? [entry.url] : []))].sort(compareKeys);
    return {
      rule,
      name: SEO_RULE_LABELS[rule],
      description: SEO_RULE_DESCRIPTIONS[rule],
      severity: SEO_RULE_DEFINITIONS[rule].severity,
      pending_count: pendingCounts.get(rule) ?? 0,
      ignored: configured.some((entry) => !entry.url),
      ignored_urls: ignoredUrls,
    };
  });
}
