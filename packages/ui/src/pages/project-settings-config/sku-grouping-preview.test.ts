import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SiteIndexApi, SkuGroupingPreview, SkuGroupingRule } from "@siteindex/shared";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./sku-grouping-preview";

const result: SkuGroupingPreview = {
  parents: 2,
  children: 5,
  samples: [{ parent: "DEMO001A", children: ["DEMO001A01", "DEMO001A02"] }],
  unmatched: 3,
  collisions: [{ parent: "DEMO002A", children: ["DEMO002A01", "DEMO002A02"] }],
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
    const rule: SkuGroupingRule = { type: "regex", value: "^(.+?)\\d{1,3}$" };

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
    expect(source).toContain("groupingPreview.collisions?.length");
    expect(source).toContain("有 {groupingPreview.collisions.length} 个父 SKU 本身也是在售 SKU，已跳过分组");
    expect(source).toContain("groupingPreview.collisions.map((collision)");
    expect(source).toContain("collision.parent");
    expect(source).toContain("collision.children.join(\"、\")");
    expect(source).toContain('queryClient.invalidateQueries({ queryKey: ["sku-grouping-preview", id] })');
    expect(source).toContain("不代表父 SKU 库存或在线率");
    expect(source).toContain("可能把以数字结尾的普通 SKU 误判为子 SKU，也不识别末尾字母后缀。");
    expect(source).toContain("已匹配 <strong>{groupingPreview.children}</strong> 个子 SKU");
    expect(source).toContain("未匹配 <strong>{groupingPreview.unmatched}</strong> 个");
    expect(source).not.toMatch(/parentSkuForRule|previewSkuGroups|pageSize:\s*100/);
    expect(source).not.toContain("api.inventory.listSkus");
  });
});
