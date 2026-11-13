// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectSummary } from "@siteindex/shared";
import { PROJECT_TABS, ProjectHeader, ProjectTabPanel, projectPanelId, projectTabId } from "../project-header";
import { Button } from "../primitives";

const project: Pick<ProjectSummary, "id" | "name" | "domain" | "platform" | "storage_location"> = {
  id: "demo-store",
  name: "示例商店",
  domain: "store.example.test",
  platform: "shopify",
};

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

describe("ProjectHeader compact layout", () => {
  it("keeps identity on the first row and puts page title, metadata, and actions on the tab row", () => {
    const { container } = render(<MemoryRouter>
      <ProjectHeader
        project={project}
        activeTab="products"
        hasTabPanel
        status={<span>同步完成</span>}
        pageTitle="产品"
        pageMeta="数据日期：11-08 17:00"
        actions={<Button>导出 CSV</Button>}
      />
    </MemoryRouter>);
    const identity = container.querySelector(".si-project-header-row");
    const tabsRow = container.querySelector(".si-project-header-tabs-row");
    expect(identity?.textContent).toContain("示例商店");
    expect(identity?.textContent).toContain("store.example.test");
    expect(identity?.textContent).toContain("同步完成");
    expect(identity?.textContent).not.toContain("导出 CSV");
    expect(tabsRow?.textContent).toContain("产品管理");
    expect(tabsRow?.textContent).toContain("11-08 17:00");
    expect(tabsRow?.textContent).toContain("导出 CSV");
    expect(container.querySelector(".si-project-header-tabs-row .si-tabs")).not.toBeNull();
    expect(container.querySelector(".si-project-header-action-slot .si-project-header-actions")).not.toBeNull();
  });

  it("uses one products tab and maps the legacy inventory view to its selection and IDs", () => {
    const { container } = render(<MemoryRouter initialEntries={["/p/demo-store/inventory"]}>
      <ProjectHeader project={project} activeTab="inventory" hasTabPanel />
      <ProjectTabPanel projectId={project.id} tab="inventory">库存明细</ProjectTabPanel>
      <CurrentPath />
    </MemoryRouter>);
    const scoped = within(container);

    const productTab = scoped.getByRole("tab", { name: "产品管理" });
    expect(PROJECT_TABS.filter(({ value }) => value === "products")).toHaveLength(1);
    expect(scoped.queryByRole("tab", { name: "库存" })).toBeNull();
    expect(productTab.getAttribute("aria-selected")).toBe("true");
    expect(productTab.id).toBe(projectTabId(project.id, "products"));
    expect(scoped.getByRole("tabpanel").id).toBe(projectPanelId(project.id, "products"));
    expect(scoped.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(productTab.id);

    fireEvent.click(productTab);
    expect(scoped.getByTestId("current-path").textContent).toBe("/p/demo-store/products");
  });

  it("reserves the action slot when a tab has no visible actions", () => {
    const { container } = render(<MemoryRouter><ProjectHeader project={project} activeTab="products" /></MemoryRouter>);
    expect(container.querySelector(".si-project-header-action-slot")).not.toBeNull();
    expect(container.querySelector(".si-project-header-action-slot .si-project-header-actions")).toBeNull();
  });

  it("scrolls the selected tab fully into the visible tab strip", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("si-tabs")) return new DOMRect(0, 0, 300, 44);
      if (this.getAttribute("role") === "tab" && this.getAttribute("aria-selected") === "true") return new DOMRect(280, 0, 70, 44);
      return new DOMRect(0, 0, 0, 0);
    });

    const { container } = render(<MemoryRouter><ProjectHeader project={project} activeTab="settings" /></MemoryRouter>);

    const scrollLeft = (container.querySelector(".si-tabs") as HTMLElement).scrollLeft;
    rectSpy.mockRestore();
    expect(scrollLeft).toBe(50);
  });

  it("warns when a project is known to be under third-party sync", () => {
    render(<MemoryRouter><ProjectHeader project={{ ...project, storage_location: "known_cloud_sync" }} activeTab="products" /></MemoryRouter>);
    expect(screen.getByRole("note", { name: /当前版本仅支持查看/ }).textContent).toContain("已识别同步目录 · 只读");
  });

  it("does not claim an unclassified project is local", () => {
    const { container } = render(<MemoryRouter><ProjectHeader project={project} activeTab="products" /></MemoryRouter>);
    expect(container.querySelector(".si-project-header-storage-warning")).toBeNull();
  });

  it("routes overflow actions through the shared keyboard-accessible menu", () => {
    const onSelect = vi.fn();
    render(<MemoryRouter>
      <ProjectHeader
        project={project}
        activeTab="products"
        pageTitle="产品"
        overflow={[{ label: "SKU 父子规则设置", onSelect }]}
      />
    </MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "SKU 父子规则设置" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
