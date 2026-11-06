import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("../SeoPage.tsx", import.meta.url), "utf8");
const pageStyles = readFileSync(new URL("./page.css", import.meta.url), "utf8");

describe("SEO 内链视图孤立页面布局", () => {
  it("将孤立页面列表放在表格外并默认折叠为汇总行", () => {
    expect(pageSource.indexOf('tableId="seo.links"')).toBeLessThan(pageSource.indexOf('{view === "links" && <details className="si-seo-orphans">'));
    expect(pageSource).toContain("孤立页面 {orphansQuery.data?.length ?? \"—\"} 个");
    expect(pageStyles).toMatch(/\.si-seo-orphans\s*\{[^}]*flex:\s*none/s);
    expect(pageStyles).toMatch(/\.si-seo-orphans-list\s*\{[^}]*max-height:\s*200px[^}]*overflow:\s*auto/s);
    expect(pageStyles).toMatch(/\.si-seo-page \.si-data-table\.is-fill\s*\{[^}]*min-height:\s*var\(--si-table-min-h,\s*320px\)/s);
  });

  it("mock 提供至少 60 条虚构孤立页面以复现长列表", () => {
    const mockSource = readFileSync(new URL("../../mock/context.ts", import.meta.url), "utf8");
    expect(mockSource).toContain("Array.from({ length: 64 }");
    expect(mockSource).toContain("https://demo-store.example.test/demo/orphan-page-${index + 1}");
  });
});
