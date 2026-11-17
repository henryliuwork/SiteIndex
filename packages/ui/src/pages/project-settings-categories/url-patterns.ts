export function splitCategoryUrlPatterns(value: string | undefined): string[] {
  return (value ?? "").split(",").map((pattern) => pattern.trim());
}

export function joinCategoryUrlPatterns(patterns: string[]): string {
  return patterns.map((pattern) => pattern.trim()).join(", ");
}

export function categoryUrlPatternError(patterns: string[]): string | null {
  if (patterns.every((pattern) => !pattern.trim())) return "请至少添加一条分类 URL 规则。";
  if (patterns.some((pattern) => !pattern.trim())) return "请填完或删除空白的分类 URL 规则。";
  if (patterns.some((pattern) => !pattern.startsWith("/") || pattern.split("{slug}").length !== 2)) {
    return "每条规则需以 / 开头，并且只包含一个 {slug}。";
  }
  if (new Set(patterns.map((pattern) => pattern.toLowerCase())).size !== patterns.length) {
    return "请删除重复的分类 URL 规则。";
  }
  return null;
}
