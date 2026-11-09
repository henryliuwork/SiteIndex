// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ProjectSummary } from "@siteindex/shared";
import { ProjectHeader } from "../project-header";
import { Button } from "../primitives";

const project: Pick<ProjectSummary, "id" | "name" | "domain" | "platform"> = {
  id: "demo-store",
  name: "示例商店",
  domain: "store.example.test",
  platform: "shopify",
};

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
    expect(tabsRow?.textContent).toContain("产品");
    expect(tabsRow?.textContent).toContain("11-08 17:00");
    expect(tabsRow?.textContent).toContain("导出 CSV");
    expect(container.querySelector(".si-project-header-tabs-row .si-tabs")).not.toBeNull();
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
