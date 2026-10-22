/** SEO 长度评级：界面（标色）与 core（生成 issues）共用同一套规则 */

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
