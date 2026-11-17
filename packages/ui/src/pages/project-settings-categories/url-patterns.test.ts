import { describe, expect, it } from "vitest";
import { categoryUrlPatternError, joinCategoryUrlPatterns, splitCategoryUrlPatterns } from "./url-patterns";

describe("分类 URL 多前缀编辑", () => {
  it("保留输入顺序并按 Core 契约序列化为逗号分隔字符串", () => {
    const patterns = splitCategoryUrlPatterns(" /shop/{slug}, /product-category/{slug} ");
    expect(patterns).toEqual(["/shop/{slug}", "/product-category/{slug}"]);
    expect(joinCategoryUrlPatterns(patterns)).toBe("/shop/{slug}, /product-category/{slug}");
    expect(categoryUrlPatternError(patterns)).toBeNull();
  });

  it("阻止空规则、缺少 slug 占位符和重复前缀进入预览与保存", () => {
    expect(categoryUrlPatternError(["/shop/{slug}", ""])).toMatch(/空白/);
    expect(categoryUrlPatternError(["/shop/"])).toMatch(/\{slug\}/);
    expect(categoryUrlPatternError(["/shop/{slug}", "/SHOP/{slug}"])).toMatch(/重复/);
  });
});
