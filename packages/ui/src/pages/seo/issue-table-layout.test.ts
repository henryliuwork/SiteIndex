import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("../SeoPage.tsx", import.meta.url), "utf8");
const pageStyles = readFileSync(new URL("./page.css", import.meta.url), "utf8");

describe("SEO 问题表格行布局", () => {
  it("从列定义声明 SEO 表格宽度，并将 URL 截断限制在自己的单元格中", () => {
    expect(pageStyles).not.toContain("nth-child");
    expect(pageSource).toContain('meta: { width: 320, grow: 2, minWidth: 220, text: "single" }');
    expect(pageSource).toContain('meta: { width: 220, grow: 1, minWidth: 160, text: "clamp2" }');
    expect(pageSource).toContain('meta: { width: 100, grow: 0, minWidth: 92, text: "single" }');
    expect(pageStyles).toMatch(/\.si-seo-url\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s);
    expect(pageSource).toContain('title={row.original.url}');
  });

  it("限制问题标题和描述在两行内容高度内，匹配虚拟行高", () => {
    expect(pageSource).toContain('id: "problem", accessorKey: "detail", header: "问题", meta: { width: 220, grow: 1, minWidth: 160, text: "clamp2" }');
    expect(pageStyles).toMatch(/\.si-seo-issue-cell > span\s*\{[^}]*line-height:\s*var\(--lh-body\)[^}]*-webkit-line-clamp:\s*2/s);
    expect(pageSource).toContain("rowHeight={52}");
    expect(pageSource).toContain("title={row.original.detail}");
  });
});
