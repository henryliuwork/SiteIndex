export const configSectionLinks = [
  ["basic", "基本信息"],
  ["brand", "品牌"],
  ["source", "数据源"],
  ["crawl", "抓取"],
  ["blog-recognition", "博客识别"],
  ["sku-grouping", "父子 SKU"],
  ["watched-categories", "关注分类"],
  ["seo", "SEO"],
  ["edm", "EDM"],
  ["integrations", "集成与预留数据源"],
] as const;

export const configSectionIds = configSectionLinks.map(([sectionId]) => sectionId);
export type ConfigSectionId = typeof configSectionIds[number];

export function isConfigSectionId(value: string | null): value is ConfigSectionId {
  return configSectionIds.some((sectionId) => sectionId === value);
}

export function scrollToConfigSection(sectionId: ConfigSectionId, root: Pick<Document, "getElementById"> = document): boolean {
  const section = root.getElementById(sectionId);
  if (!section) return false;
  section.scrollIntoView({ block: "start" });
  return true;
}
