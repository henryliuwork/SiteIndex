import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("../SeoPage.tsx", import.meta.url), "utf8");
const pageStyles = readFileSync(new URL("./page.css", import.meta.url), "utf8");

describe("SEO 问题表格行布局", () => {
  it("将 URL 截断限制在自己的固定宽度单元格中，并保留完整值供悬停查看", () => {
    expect(pageStyles).toMatch(/\.si-seo-table-issues \.si-table td:nth-child\(2\)\s*\{\s*overflow:\s*hidden;/);
    expect(pageStyles).toMatch(/\.si-seo-url\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s);
    expect(pageSource).toContain('title={row.original.url}');
  });

  it("限制问题标题和描述在两行内容高度内，匹配虚拟行高", () => {
    expect(pageStyles).toMatch(/\.si-seo-table-issues \.si-table td:nth-child\(3\)\s*\{\s*overflow:\s*hidden;/);
    expect(pageStyles).toMatch(/\.si-seo-issue-cell\s*\{[^}]*line-height:\s*16px/s);
    expect(pageStyles).toMatch(/\.si-seo-issue-cell > span\s*\{[^}]*line-height:\s*16px[^}]*-webkit-line-clamp:\s*2/s);
    expect(pageStyles).toContain(".si-seo-table-frame .si-table td {\nheight: 52px;");
    expect(pageSource).toContain("rowHeight={52}");
    expect(pageSource).toContain("title={row.original.detail}");
  });
});
