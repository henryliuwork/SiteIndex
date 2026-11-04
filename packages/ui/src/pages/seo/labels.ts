export const issueLabels: Record<string, string> = {
  http_4xx: "页面 4xx", http_5xx: "页面 5xx", redirect_chain: "重定向链", noindex: "noindex",
  canonical_other: "Canonical 指向其他页面", canonical_missing: "Canonical 缺失", not_in_sitemap: "未在 Sitemap 中",
  title_missing: "Title 缺失", desc_missing: "Meta description 缺失", title_length: "Title 长度异常",
  desc_length: "Description 长度异常", title_duplicate: "Title 重复", desc_duplicate: "Description 重复",
  h1_missing: "H1 缺失", h1_multiple: "H1 多个", schema_missing: "Schema 缺失", schema_error: "Schema 错误",
  img_alt_missing: "图片 Alt 缺失", thin_content: "内容过短", orphan: "孤立页面",
  title_too_short: "Title 过短", title_too_long: "Title 过长", desc_too_short: "Description 过短",
  desc_too_long: "Description 过长", hreflang_mismatch: "hreflang 异常", url_too_long: "URL 过长",
};
