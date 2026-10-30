import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ProjectSummary } from "@siteindex/shared";
import { ProjectHeader, ProjectTabPanel, projectPanelId, projectTabId } from "../components";

const pageCases = [
  {
    file: "OverviewPage.tsx",
    tab: "overview",
    projectIdExpression: "summary.id",
    normal: "si-overview-kpis",
    loading: "overviewQuery.isLoading",
    error: "overviewQuery.isError",
    empty: "overview.attention.length ?",
  },
  {
    file: "ProductsPage.tsx",
    tab: "products",
    projectIdExpression: "project.id",
    normal: "si-products-table-frame",
    loading: "listQuery.isLoading",
    error: "listQuery.isError",
    empty: 'emptyTitle="没有匹配的产品"',
  },
  {
    file: "EdmPage.tsx",
    tab: "edm",
    projectIdExpression: "project.id",
    normal: "si-edm-rule-note",
    loading: "listQuery.isLoading",
    error: "listQuery.isError",
    empty: 'emptyTitle="没有 SKU 图片记录"',
  },
  {
    file: "DesignPage.tsx",
    tab: "design",
    projectIdExpression: "project.id",
    normal: "si-design-layout",
    loading: "designQuery.isLoading",
    error: "designQuery.isError",
    empty: "<SpacingCard tokens={tokens}",
  },
] as const;

const testProject: Pick<ProjectSummary, "id" | "name" | "domain" | "platform"> = {
  id: "merchant/site",
  name: "演示项目",
  domain: "example.test",
  platform: "shopify",
};

describe("D 项目页面 tabpanel 接入", () => {
  it.each(pageCases)("$file 为 $tab 提供匹配的 tab 与 panel，并覆盖页面状态", (page) => {
    const source = readFileSync(new URL(`./${page.file}`, import.meta.url), "utf8");
    const tabId = source.indexOf(`activeTab="${page.tab}"`);
    const panelStart = source.indexOf(`<ProjectTabPanel projectId={${page.projectIdExpression}} tab="${page.tab}">`);
    const panelEnd = source.indexOf("</ProjectTabPanel>", panelStart);

    expect(tabId).toBeGreaterThanOrEqual(0);
    expect(source.slice(tabId, tabId + 100)).toContain("hasTabPanel");
    expect(panelStart).toBeGreaterThan(tabId);
    expect(panelEnd).toBeGreaterThan(panelStart);

    const panelBody = source.slice(panelStart, panelEnd);
    expect(panelBody).toContain(page.normal);
    expect(panelBody).toContain(page.loading);
    expect(panelBody).toContain(page.error);
    expect(panelBody).toContain(page.empty);
    if (page.tab === "design") {
      expect(source).toContain('!tokens && <p className="si-design-empty">');
    }
  });

  it.each(pageCases)("$tab 的共享组件输出双向 ARIA 关联", ({ tab }) => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ProjectHeader project={testProject} activeTab={tab} hasTabPanel />
        <ProjectTabPanel projectId={testProject.id} tab={tab}>页面内容</ProjectTabPanel>
      </MemoryRouter>,
    );
    const tabId = projectTabId(testProject.id, tab);
    const panelId = projectPanelId(testProject.id, tab);

    expect(markup).toContain(`id="${tabId}"`);
    expect(markup).toContain(`aria-controls="${panelId}"`);
    expect(markup).toContain(`id="${panelId}" role="tabpanel" aria-labelledby="${tabId}" tabindex="0"`);
  });
});
