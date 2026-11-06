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

async function renderEdmPage(groupingEnabled: boolean) {
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
  const listImages = vi.fn(mockApi.edm.listImages);
  mockApi.edm.listImages = listImages;
  const previewGrouping = vi.fn(async () => ({
    parents: 1,
    children: 2,
    unmatched: 3,
    samples: [{ parent: "DEMO001A", children: ["DEMO001A01", "DEMO001A02"] }],
  }));
  mockApi.sku = { previewGrouping };

  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  const [{ EdmPage }] = await Promise.all([import("./EdmPage")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/p/demo/edm"]}>
        <Routes>
          <Route path="/p/:id/edm" element={<EdmPage />} />
          <Route path="/p/:id/settings/config" element={<div>项目设置页</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { mockApi, listImages, previewGrouping };
}

describe("EdmPage D-5", () => {
  it("显示标准 DataTable 分页与父 SKU 筛选，并向 IPC 传入 parent_only", async () => {
    const { listImages } = await renderEdmPage(true);
    const parentOnly = await screen.findByRole("checkbox", { name: "仅展示父 SKU" });
    expect(screen.getByRole("combobox", { name: "每页条数" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "50" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "100" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "200" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "全部" })).toBeTruthy();

    fireEvent.click(parentOnly);
    await waitFor(() => expect(listImages).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ parent_only: true }),
    })));
  }, 15_000);

  it("未启用分组时点击父 SKU 筛选展示 Core 预览并引导到项目设置", async () => {
    const { mockApi, previewGrouping } = await renderEdmPage(false);
    fireEvent.click(await screen.findByRole("checkbox", { name: "仅展示父 SKU" }));

    expect(await screen.findByRole("dialog", { name: "配置父子 SKU 规则" })).toBeTruthy();
    expect(await screen.findByText(/已匹配/)).toBeTruthy();
    expect(mockApi.sku?.previewGrouping).toHaveBeenCalledWith("demo", expect.objectContaining({ type: expect.any(String) }));
    expect(previewGrouping).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "前往项目设置" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/p/demo/settings/config?section=sku-grouping"));
  }, 15_000);
});
