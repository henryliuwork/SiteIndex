import type { SiteIndexApi, SkuGroupingPreview, SkuGroupingRule } from "@siteindex/shared";

type SkuGroupingPreviewApi = Pick<SiteIndexApi, "sku">;

export function skuGroupingPreviewQueryKey(projectId: string, rule: SkuGroupingRule) {
  return ["sku-grouping-preview", projectId, rule] as const;
}

export async function fetchSkuGroupingPreview(
  api: SkuGroupingPreviewApi,
  projectId: string,
  rule: SkuGroupingRule,
): Promise<SkuGroupingPreview> {
  if (!api.sku?.previewGrouping) {
    throw new Error("当前运行环境未提供 SKU 分组预览 IPC，请更新桌面应用后重试。");
  }
  return api.sku.previewGrouping(projectId, rule);
}
