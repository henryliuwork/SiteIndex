// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectSummary } from "@siteindex/shared";
import { PROJECT_TABS, ProjectHeader, ProjectTabPanel, fitProjectTabs, projectPanelId, projectTabId } from "../project-header";
import { Button } from "../primitives";
import { formatDateTime } from "../utils";

const project: Pick<ProjectSummary, "id" | "name" | "domain" | "platform" | "storage_location" | "sync"> = {
  id: "demo-store",
  name: "示例商店",
  domain: "store.example.test",
  platform: "shopify",
  sync: { state: "ok", at: "2026-11-13T08:30:00.000Z", job: null },
};

afterEach(cleanup);

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

describe("ProjectHeader compact layout", () => {
  it("keeps the shared project navigation order and all project destinations", () => {
    const { container } = render(<MemoryRouter initialEntries={["/p/demo-store/products"]}>
      <ProjectHeader project={project} activeTab="products" />
      <CurrentPath />
    </MemoryRouter>);
    const scoped = within(container);

    expect(PROJECT_TABS.map(({ value }) => value)).toEqual([
      "overview", "todos", "products", "seo", "content", "edm", "design", "readme", "runs", "settings",
    ]);

    const destinations = [
      ["概览", "/p/demo-store"],
      ["待办", "/p/demo-store/todos"],
      ["产品管理", "/p/demo-store/products"],
      ["SEO", "/p/demo-store/seo"],
      ["内容", "/p/demo-store/content"],
      ["EDM", "/p/demo-store/edm"],
      ["设计", "/p/demo-store/design"],
      ["README", "/p/demo-store/readme"],
      ["运行", "/p/demo-store/runs"],
      ["设置", "/p/demo-store/settings/config"],
    ] as const;
    for (const [label, path] of destinations) {
      fireEvent.click(scoped.getByRole("tab", { name: label }));
      expect(scoped.getByTestId("current-path").textContent).toBe(path);
    }
  });

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

  it("uses a single products tab and stable tab/panel IDs", () => {
    const { container } = render(<MemoryRouter initialEntries={["/p/demo-store/products"]}>
      <ProjectHeader project={project} activeTab="products" hasTabPanel />
      <ProjectTabPanel projectId={project.id} tab="products">产品列表</ProjectTabPanel>
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

  it("shows one absolute sync time and removes a duplicate from the page status", () => {
    const time = formatDateTime(project.sync.at);
    const { container } = render(<MemoryRouter>
      <ProjectHeader project={project} activeTab="overview" status={<span>{time} · 同步成功</span>} />
    </MemoryRouter>);
    const headerText = container.querySelector(".si-project-header-row")?.textContent ?? "";
    expect(container.querySelector(".si-project-header-status")?.textContent).toBe("同步成功");
    expect(headerText.split(time)).toHaveLength(2);
    expect(headerText).toContain("最近同步");
    expect(container.querySelector(".si-project-header-status")?.textContent).toBe("同步成功");
    expect(headerText).not.toMatch(/今天|昨天/);
  });

  it.each([
    ["daily", "最近同步"], ["weekly", "最近同步"],
    ["validate", "最近校验"], ["readme", "最近运行"], ["views", "最近运行"],
  ])("labels a %s job as %s", (job, label) => {
    const { container } = render(<MemoryRouter><ProjectHeader project={{ ...project, sync: { ...project.sync, job } }} activeTab="overview" /></MemoryRouter>);
    expect(container.querySelector(".si-project-header-sync")?.textContent).toContain(label);
    if (job !== "daily" && job !== "weekly") expect(container.querySelector(".si-project-header-sync")?.textContent).not.toContain("最近同步");
  });

  it("reserves the action slot when a tab has no visible actions", () => {
    const { container } = render(<MemoryRouter><ProjectHeader project={project} activeTab="products" /></MemoryRouter>);
    expect(container.querySelector(".si-project-header-action-slot")).not.toBeNull();
    expect(container.querySelector(".si-project-header-action-slot .si-project-header-actions")).toBeNull();
  });

  it("keeps the selected tab visible when only a subset fits", () => {
    expect(fitProjectTabs([60, 60, 60, 60, 60], 230, 4, 8, 76)).toEqual([0, 4]);
    expect(fitProjectTabs([60, 60, 60], 196, 2, 8, 76)).toEqual([0, 1, 2]);
  });

  it("moves tabs after a resize into a keyboard menu and focuses the selected destination", async () => {
    const oldClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    let stripWidth = 1000;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("si-project-tab-strip") ? stripWidth : 0; } });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, this.parentElement?.classList.contains("si-project-tab-measure") ? 60 : 0, 28);
    });
    function ResponsiveHeader() {
      const location = useLocation();
      return <><ProjectHeader project={project} activeTab={location.pathname.endsWith("/seo") ? "seo" : "settings"} hasTabPanel /><CurrentPath /></>;
    }
    try {
      render(<MemoryRouter initialEntries={["/p/demo-store/settings/config"]}><ResponsiveHeader /></MemoryRouter>);
      expect(screen.getByRole("tab", { name: "设置" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByRole("button", { name: "更多项目页面" })).toBeNull();
      stripWidth = 230;
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(screen.getByRole("button", { name: "更多项目页面" })).not.toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "更多项目页面" }));
      const menu = screen.getByRole("menu", { name: "更多项目页面" });
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "SEO" }));
      expect(screen.getByTestId("current-path").textContent).toBe("/p/demo-store/seo");
      await waitFor(() => expect(screen.getByRole("tab", { name: "SEO" })).toBe(document.activeElement));
    } finally {
      rectSpy.mockRestore();
      if (oldClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", oldClientWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
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
