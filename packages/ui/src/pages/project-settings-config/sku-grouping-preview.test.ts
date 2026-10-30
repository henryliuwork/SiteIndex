import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SiteIndexApi, SkuGroupingPreview, SkuGroupingRule } from "@siteindex/shared";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./sku-grouping-preview";

const result: SkuGroupingPreview = {
  parents: 2,
  children: 5,
  samples: [{ parent: "LAMP", children: ["LAMP-BLK", "LAMP-WHT"] }],
  unmatched: 3,
};

describe("SKU 分组预览 IPC", () => {
  it("将项目与完整规则纳入查询 key", () => {
    const suffixRule: SkuGroupingRule = { type: "suffix", value: "-G" };
    const separatorRule: SkuGroupingRule = { type: "separator", value: "-" };

    expect(skuGroupingPreviewQueryKey("demo", suffixRule)).toEqual(["sku-grouping-preview", "demo", suffixRule]);
    expect(skuGroupingPreviewQueryKey("demo", suffixRule)).not.toEqual(skuGroupingPreviewQueryKey("demo", separatorRule));
    expect(skuGroupingPreviewQueryKey("other", suffixRule)).not.toEqual(skuGroupingPreviewQueryKey("demo", suffixRule));
  });

  it("直接返回 Core 对完整 SKU 集合的预览结果", async () => {
    const previewGrouping = vi.fn(async () => result);
    const api: Pick<SiteIndexApi, "sku"> = { sku: { previewGrouping } };
    const rule: SkuGroupingRule = { type: "regex", value: "^(.+?)-[A-Z]+$" };

    await expect(fetchSkuGroupingPreview(api, "demo", rule)).resolves.toBe(result);
    expect(previewGrouping).toHaveBeenCalledOnce();
    expect(previewGrouping).toHaveBeenCalledWith("demo", rule);
  });

  it("IPC 不可用时明确失败，不提供本地近似结果", async () => {
    const api: Pick<SiteIndexApi, "sku"> = {};

    await expect(fetchSkuGroupingPreview(api, "demo", { type: "separator", value: "-" }))
      .rejects.toThrow("当前运行环境未提供 SKU 分组预览 IPC");
  });

  it("页面使用完整规则查询并覆盖预览状态与缓存刷新", () => {
    const source = readFileSync(new URL("../ProjectSettingsConfigPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("skuGroupingPreviewQueryKey(id, grouping.rule)");
    expect(source).toContain("fetchSkuGroupingPreview(api, id, grouping.rule)");
    expect(source).toContain("skuPreviewQuery.isLoading");
    expect(source).toContain("skuPreviewQuery.isError");
    expect(source).toContain("skuPreviewQuery.refetch()");
    expect(source).toContain("当前规则未识别到父子 SKU 分组。");
    expect(source).toContain('queryClient.invalidateQueries({ queryKey: ["sku-grouping-preview", id] })');
    expect(source).toContain("不代表父 SKU 库存或在线率");
    expect(source).not.toMatch(/parentSkuForRule|previewSkuGroups|pageSize:\s*100/);
    expect(source).not.toContain("api.inventory.listSkus");
  });
});
