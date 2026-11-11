// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { createMockApi } from "../mock";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.restoreAllMocks();
  vi.resetModules();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

async function renderInventoryPage(groupingEnabled: boolean, skuListPending = false) {
  const mockApi = createMockApi();
  const project = await mockApi.projects.get("demo");
  mockApi.projects.get = vi.fn(async () => ({
    ...project,
    config: {
      ...project.config,
      sku_grouping: {
        enabled: groupingEnabled,
        rule: project.config.sku_grouping?.rule ?? { type: "separator", value: "-" },
      },
    },
  }));
  const listSkus = vi.fn(mockApi.inventory.listSkus);
  if (skuListPending) {
    listSkus.mockImplementation(() => new Promise<Awaited<ReturnType<typeof mockApi.inventory.listSkus>>>(() => {}));
  }
  mockApi.inventory.listSkus = listSkus;
  mockApi.sku = {
    previewGrouping: vi.fn(async () => ({
      parents: 1,
      children: 2,
      unmatched: 3,
      samples: [{ parent: "DEMO001A", children: ["DEMO001A01", "DEMO001A02"] }],
    })),
  };

  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  const [{ InventoryPage }, { ToastProvider }] = await Promise.all([import("./InventoryPage"), import("../components/overlays")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/demo/inventory"]}>
          <Routes>
            <Route path="/p/:id/inventory" element={<InventoryPage />} />
            <Route path="/p/:id/settings/config" element={<div>项目设置页</div>} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { mockApi, listSkus };
}

describe("InventoryPage D-2", () => {
  it("首次加载 SKU 时显示加载状态，不显示空结果表格", async () => {
    const { listSkus } = await renderInventoryPage(true, true);

    expect(await screen.findByText("正在加载 SKU 列表…")).toBeTruthy();
    expect(listSkus).toHaveBeenCalledOnce();
    expect(screen.queryByText("没有匹配的 SKU")).toBeNull();
  });

  it("父 SKU 开关始终可见；未启用分组时打开 Core 预览并引导到设置", async () => {
    const { mockApi } = await renderInventoryPage(false);
    const parentOnly = await screen.findByRole("checkbox", { name: "仅展示父 SKU" });
    fireEvent.click(parentOnly);

    expect(await screen.findByRole("dialog", { name: "配置父子 SKU 规则" })).toBeTruthy();
    expect(await screen.findByText(/已匹配/)).toBeTruthy();
    expect(screen.getByText(/DEMO001A01、DEMO001A02/)).toBeTruthy();
    expect(mockApi.sku?.previewGrouping).toHaveBeenCalledWith("demo", expect.objectContaining({ type: expect.any(String) }));

    fireEvent.click(screen.getByRole("button", { name: "前往项目设置" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/p/demo/settings/config?section=sku-grouping"));
  }, 15_000);

  it("启用分组时通过 parent_only 查询 Core 库存列表", async () => {
    const { listSkus } = await renderInventoryPage(true);
    const parentOnly = await screen.findByRole("checkbox", { name: "仅展示父 SKU" });
    fireEvent.click(parentOnly);

    await waitFor(() => expect(listSkus).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ parent_only: true }),
    })));
    expect(screen.queryByRole("dialog", { name: "配置父子 SKU 规则" })).toBeNull();
  });

  it("将状态筛选作为单选下拉条件传给 Core 库存列表", async () => {
    const { listSkus } = await renderInventoryPage(true);
    fireEvent.click(await screen.findByRole("combobox", { name: "库存状态筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "有货" }));

    await waitFor(() => expect(listSkus).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ status: "in_stock" }),
    })));
  }, 15_000);

  it("将趋势与分类面板放进页面操作区 Drawer，单日历史只显示单点说明", async () => {
    await renderInventoryPage(true);
    fireEvent.click(await screen.findByRole("button", { name: "趋势与分类在线率" }));

    expect(await screen.findByRole("dialog", { name: "库存趋势与分类在线率" })).toBeTruthy();
    expect(await screen.findByText("目前仅有 1 个业务日期，后续每日同步自动形成趋势。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置关注分类" })).toBeTruthy();
  });

  it("将 Feed 异常与移除区分，并把筛选限制在今日变化摘要", async () => {
    await renderInventoryPage(true);
    fireEvent.click(await screen.findByRole("button", { name: "趋势与分类在线率" }));

    expect(await screen.findByText("DEMO-ANOMALY-01")).toBeTruthy();
    expect(screen.getByText("DEMO-REMOVED-01")).toBeTruthy();
    expect(screen.getByText("Feed 异常")).toBeTruthy();
    expect(screen.getByText("已下架")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "仅显示此摘要中的 Feed 异常" }));

    expect(screen.getByText("DEMO-ANOMALY-01")).toBeTruthy();
    expect(screen.queryByText("DEMO-REMOVED-01")).toBeNull();
  });
});
