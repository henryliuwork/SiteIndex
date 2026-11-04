import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { attentionDestination, labelAttentionText, OverviewSummary, parseOverviewMarkdown } from "./summary";

describe("概览 README 摘要格式化", () => {
  it("移除 HTML 注释并把段落和列表拆成独立块", () => {
    const markdown = "项目信息\n<!-- 私有注释 -->\n\n- 分类 A\n- 分类 B\n\n第二段";
    expect(parseOverviewMarkdown(markdown))
      .toEqual([
        { kind: "paragraph", text: "项目信息" },
        { kind: "list", ordered: false, items: ["分类 A", "分类 B"] },
        { kind: "paragraph", text: "第二段" },
      ]);
    const rendered = renderToStaticMarkup(createElement(OverviewSummary, { markdown }));
    expect(rendered).toContain("<ul><li>分类 A</li><li>分类 B</li></ul>");
    expect(rendered).not.toContain("私有注释");
  });

  it("把需要关注中的 SEO 规则键转换为中文名", () => {
    expect(labelAttentionText("SEO desc_duplicate、schema_missing"))
      .toBe("SEO Description 重复、Schema 缺失");
  });

  it("保留软件内路由并将外部网页链接兜底到项目 SEO 页", () => {
    expect(attentionDestination("/p/demo/inventory", "demo")).toBe("/p/demo/inventory");
    expect(attentionDestination("https://shop.example.test/products/item", "demo")).toBe("/p/demo/seo");
  });
});
