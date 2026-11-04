/** SEO 长度评级：界面（标色）与 core（生成 issues）共用同一套规则 */
import type { SeoRule } from "./models";

/** SEO 规则的统一中文名；包含仍需兼容的旧长度规则键。 */
export const SEO_RULE_LABELS: Record<SeoRule, string> = {
  http_4xx: "页面 4xx", http_5xx: "页面 5xx", redirect_chain: "重定向链", noindex: "noindex",
  canonical_other: "Canonical 指向其他页面", canonical_missing: "Canonical 缺失", not_in_sitemap: "未在 Sitemap 中",
  title_missing: "Title 缺失", desc_missing: "Meta description 缺失", title_length: "Title 长度异常",
  desc_length: "Description 长度异常", title_duplicate: "Title 重复", desc_duplicate: "Description 重复",
  h1_missing: "H1 缺失", h1_multiple: "H1 多个", schema_missing: "Schema 缺失", schema_error: "Schema 错误",
  img_alt_missing: "图片 Alt 缺失", thin_content: "内容过短", orphan: "孤立页面",
  title_too_short: "Title 过短", title_too_long: "Title 过长", desc_too_short: "Description 过短",
  desc_too_long: "Description 过长", hreflang_invalid: "hreflang 异常", url_too_long: "URL 过长",
};

export type LengthGrade = "good" | "fair" | "poor";

export const DEFAULT_TITLE_RANGE: [number, number] = [30, 60];
export const DEFAULT_DESCRIPTION_RANGE: [number, number] = [120, 160];

/** 可接受区间 = 最佳区间向外各放宽一段（Title ±10，Description 下 50 / 上 20） */
export function gradeTitleLength(n: number, range: [number, number] = DEFAULT_TITLE_RANGE): LengthGrade {
  const [min, max] = range;
  if (n >= min && n <= max) return "good";
  if (n >= min - 10 && n <= max + 10 && n > 0) return "fair";
  return "poor";
}

export function gradeDescriptionLength(n: number, range: [number, number] = DEFAULT_DESCRIPTION_RANGE): LengthGrade {
  const [min, max] = range;
  if (n >= min && n <= max) return "good";
  if (n >= min - 50 && n <= max + 20 && n > 0) return "fair";
  return "poor";
}

/** Google site: 查询地址 */
export function googleSiteSearchUrl(pageUrl: string): string {
  const target = pageUrl.replace(/^https?:\/\//i, "");
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${target}`)}`;
}
