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

async function renderEdmPage(groupingEnabled: boolean, mockMode = true) {
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
    isMockApi: mockMode,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  const [{ EdmPage }, { ToastProvider }] = await Promise.all([import("./EdmPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ToastProvider>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/p/demo/edm"]}>
        <Routes>
          <Route path="/p/:id/edm" element={<EdmPage />} />
          <Route path="/p/:id/settings/config" element={<div>项目设置页</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
    </ToastProvider>,
  );
  return { mockApi, listImages, previewGrouping };
}

async function openMediaDemo() {
  fireEvent.click(await screen.findByRole("button", { name: "交互模拟（仅本地演示，不会上传或写入台账）" }));
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

describe("EdmPage media preparation prototype", () => {
  it("在 mock 中提供明确不会上传的多选演示，并展示逐 SKU 结果状态", async () => {
    const { mockApi } = await renderEdmPage(true);
    const toggle = await screen.findByRole("button", { name: "交互模拟（仅本地演示，不会上传或写入台账）" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("si-edm-media-demo-panel");
    expect(document.getElementById("si-edm-media-demo-panel")).toBeTruthy();
    expect("media" in mockApi).toBe(false);
    await openMediaDemo();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("选择表格行后可预览逐 SKU 结果；该演示不调用 media.prepare、Job 或外部服务。")).toBeTruthy();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));

    const button = await screen.findByRole("button", { name: /模拟获取图片 URL/ });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText(/上传 \d+|复用 \d+|记录 \d+/)).toBeTruthy();
    expect(screen.getAllByText(/（模拟）/).length).toBeGreaterThan(0);
  }, 15_000);

  it.each([
    ["WP_AUTH_FAILED", "401 认证失败并停批"],
    ["WP_FORBIDDEN", "403 权限不足并停批"],
  ] as const)("展示 %s 停批代码与未决行", async (errorCode, optionLabel) => {
    await renderEdmPage(true);
    await openMediaDemo();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("combobox", { name: "模拟媒体准备结果" }));
    fireEvent.click(await screen.findByRole("option", { name: optionLabel }));
    fireEvent.click(await screen.findByRole("button", { name: /模拟获取图片 URL/ }));

    expect(await screen.findByText(new RegExp(errorCode + ".*模拟批次提前停止.*尚未开始"))).toBeTruthy();
    expect(screen.getAllByText("尚未开始（模拟）").length).toBeGreaterThan(0);
  }, 15_000);

  it("桌面 IPC 尚未接入时只说明不可用，不渲染可执行上传按钮", async () => {
    await renderEdmPage(true, false);
    expect(await screen.findByText(/当前桌面版尚未接通 media\.prepare 与 media Job/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /模拟获取图片 URL|获取图片 URL/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "选择当前页全部行" })).toBeNull();
  });
});
