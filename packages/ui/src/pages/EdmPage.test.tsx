// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { JobProgress, JobResult, SkuImageRow } from "@siteindex/shared";
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
  vi.doUnmock("@siteindex/shared");
  vi.restoreAllMocks();
  vi.resetModules();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

async function renderEdmPage(groupingEnabled: boolean, mockMode = true, imageRows?: SkuImageRow[], mediaReady = false) {
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
  if (imageRows) listImages.mockImplementation(async () => ({ rows: imageRows, total: imageRows.length }));
  mockApi.edm.listImages = listImages;
  const setManualImage = vi.fn(mockApi.edm.setManualImage);
  mockApi.edm.setManualImage = setManualImage;
  const mediaPrepare = vi.fn(async () => ({ runId: "demo-media-run" }));
  let onMediaProgress: ((progress: JobProgress) => void) | undefined;
  let onMediaFinished: ((result: JobResult) => void) | undefined;
  if (mediaReady) {
    vi.doMock("@siteindex/shared", async () => {
      const actual = await vi.importActual<typeof import("@siteindex/shared")>("@siteindex/shared");
      return { ...actual, PENDING_HANDLERS: [] };
    });
    mockApi.media = { prepare: mediaPrepare };
    mockApi.jobs.onProgress = (callback) => { onMediaProgress = callback; return () => { onMediaProgress = undefined; }; };
    mockApi.jobs.onFinished = (callback) => { onMediaFinished = callback; return () => { onMediaFinished = undefined; }; };
  }
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
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  return {
    mockApi, listImages, previewGrouping, setManualImage, mediaPrepare, invalidateQueries,
    emitMediaProgress: (progress: JobProgress) => onMediaProgress?.(progress),
    emitMediaFinished: (result: JobResult) => onMediaFinished?.(result),
  };
}

async function openMediaDemo() {
  fireEvent.click(await screen.findByRole("button", { name: "交互模拟（仅本地演示，不会上传或写入台账）" }));
}

function mediaImageRow(sku: string, feedImageUrl: string | null, manualImageUrl: string | null = null): SkuImageRow {
  return {
    sku, title: "虚构演示商品 " + sku, variant_title: null, stock_status: "in_stock",
    feed_image_url: feedImageUrl, manual_image_url: manualImageUrl,
    used: manualImageUrl ? "manual" : feedImageUrl ? "feed" : "none",
  };
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
    expect(screen.getByRole("button", { name: "缺图" })).toBeTruthy();

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
  it("仅跳过已有台账 URL，Feed JPG/PNG 直接记录，WebP 进入上传候选", async () => {
    const rows = [
      mediaImageRow("DEMO-LEDGER-001", "https://demo-store.example.test/demo/main.jpg", "https://images.example.test/demo/DEMO-LEDGER-001.jpg"),
      mediaImageRow("DEMO-FEED-JPG-001", "https://demo-store.example.test/demo/main.jpg"),
      mediaImageRow("DEMO-FEED-PNG-001", "https://demo-store.example.test/demo/main.png?variant=1"),
      mediaImageRow("DEMO-FEED-WEBP-001", "https://demo-store.example.test/demo/main.webp"),
    ];
    const { mockApi, setManualImage } = await renderEdmPage(true, true, rows);
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

    expect(await screen.findByText("上传 1，记录 2，已有 URL 跳过 1")).toBeTruthy();
    const results = screen.getByRole("list", { name: "模拟逐 SKU 结果" });
    expect(within(results).getByText("已上传（模拟）")).toBeTruthy();
    expect(within(results).getAllByText("原图 URL 已记录（模拟）")).toHaveLength(2);
    expect(within(results).getByText("已有 URL，已跳过（模拟）")).toBeTruthy();
    expect(setManualImage).not.toHaveBeenCalled();
  }, 15_000);

  it.each([
    ["WP_AUTH_FAILED", "401 认证失败并停批"],
    ["WP_FORBIDDEN", "403 权限不足并停批"],
  ] as const)("展示 %s 停批代码与未决行", async (errorCode, optionLabel) => {
    const rows = [
      mediaImageRow("DEMO-A-WEBP-001", "https://demo-store.example.test/demo/main.webp"),
      mediaImageRow("DEMO-B-LEDGER-001", "https://demo-store.example.test/demo/main.jpg", "https://images.example.test/demo/DEMO-B-LEDGER-001.jpg"),
      mediaImageRow("DEMO-C-FEED-PNG-001", "https://demo-store.example.test/demo/main.png"),
      mediaImageRow("DEMO-D-WEBP-001", "https://demo-store.example.test/demo/second.webp"),
    ];
    await renderEdmPage(true, true, rows);
    await openMediaDemo();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("combobox", { name: "模拟媒体准备结果" }));
    fireEvent.click(await screen.findByRole("option", { name: optionLabel }));
    fireEvent.click(await screen.findByRole("button", { name: /模拟获取图片 URL/ }));

    expect(await screen.findByText(new RegExp(errorCode + ".*模拟批次提前停止.*尚未开始"))).toBeTruthy();
    const results = screen.getByRole("list", { name: "模拟逐 SKU 结果" });
    expect(within(results).getAllByText("尚未开始（模拟）")).toHaveLength(3);
    expect(within(results).queryByText("已有 URL，已跳过（模拟）")).toBeNull();
    expect(within(results).queryByText("原图 URL 已记录（模拟）")).toBeNull();
  }, 15_000);

  it.each([
    ["WP_AUTH_FAILED", "401 认证失败并停批"],
    ["WP_FORBIDDEN", "403 权限不足并停批"],
  ] as const)("%s 场景没有上传候选时不显示提前停批", async (_errorCode, optionLabel) => {
    const rows = [
      mediaImageRow("DEMO-A-LEDGER-001", "https://demo-store.example.test/demo/main.webp", "https://images.example.test/demo/DEMO-A-LEDGER-001.jpg"),
      mediaImageRow("DEMO-B-FEED-JPG-001", "https://demo-store.example.test/demo/main.jpg"),
      mediaImageRow("DEMO-C-FEED-PNG-001", "https://demo-store.example.test/demo/main.png"),
    ];
    await renderEdmPage(true, true, rows);
    await openMediaDemo();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("combobox", { name: "模拟媒体准备结果" }));
    fireEvent.click(await screen.findByRole("option", { name: optionLabel }));
    fireEvent.click(await screen.findByRole("button", { name: /模拟获取图片 URL/ }));

    expect(await screen.findByText(/本批次没有触发权限失败/)).toBeTruthy();
    expect(screen.queryByText(/模拟批次提前停止/)).toBeNull();
    const results = screen.getByRole("list", { name: "模拟逐 SKU 结果" });
    expect(within(results).getByText("已有 URL，已跳过（模拟）")).toBeTruthy();
    expect(within(results).getAllByText("原图 URL 已记录（模拟）")).toHaveLength(2);
    expect(within(results).queryByText("尚未开始（模拟）")).toBeNull();
  }, 15_000);

  it("默认 mock 提供虚构 WebP Feed 图片作为上传候选", async () => {
    const mockApi = createMockApi();
    const page = await mockApi.edm.listImages("demo", { page: 1, pageSize: 50, filters: {} });
    expect(page.rows.some((row) => row.feed_image_url?.endsWith(".webp"))).toBe(true);
  });

  it("桌面 IPC 尚未接入时只说明不可用，不渲染可执行上传按钮", async () => {
    await renderEdmPage(true, false);
    expect(await screen.findByText(/media\.prepare 尚未完成 Core 与 Desktop 接入/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /模拟获取图片 URL|获取图片 URL/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "选择当前页全部行" })).toBeNull();
  });

  it("Core 与 Desktop handler 就绪后调用真实 IPC、展示逐 SKU 结果并刷新 EDM 缓存", async () => {
    const rows = [
      mediaImageRow("DEMO-REAL-JPG-001", "https://demo-store.example.test/demo/main.jpg"),
      mediaImageRow("DEMO-REAL-WEBP-001", "https://demo-store.example.test/demo/main.webp"),
      mediaImageRow("DEMO-REAL-WEBP-002", "https://demo-store.example.test/demo/second.webp"),
    ];
    const { mediaPrepare, invalidateQueries, emitMediaProgress, emitMediaFinished } = await renderEdmPage(true, false, rows, true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    const button = await screen.findByRole("button", { name: "获取图片 URL（3）" });
    fireEvent.click(button);

    await waitFor(() => expect(mediaPrepare).toHaveBeenCalledWith({ project: "demo", skus: ["DEMO-REAL-JPG-001", "DEMO-REAL-WEBP-001", "DEMO-REAL-WEBP-002"] }));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    emitMediaProgress({ runId: "demo-media-run", projectPath: "C:/fake/demo", job: "media", pct: 40, level: "info", message: "正在处理虚构 SKU", at: "2026-11-11T00:00:00.000Z" });
    expect(await screen.findByText("正在处理虚构 SKU")).toBeTruthy();
    emitMediaFinished({
      runId: "demo-media-run", job: "media", status: "partial", exitCode: 1, summary: "有 1 个 SKU 处理失败",
      media_error_code: "WP_AUTH_FAILED",
      media_results: [{ sku: "DEMO-REAL-JPG-001", status: "recorded" }, { sku: "DEMO-REAL-WEBP-001", status: "failed", reason: "虚构测试错误" }],
    });

    const results = await screen.findByRole("list", { name: "图片准备逐 SKU 结果" });
    expect(within(results).getByText("原图 URL 已记录")).toBeTruthy();
    expect(within(results).getByText("失败")).toBeTruthy();
    expect(within(results).getByText("尚未开始")).toBeTruthy();
    expect(await screen.findByText(/WordPress 认证失败（401），批次已停止/)).toBeTruthy();
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "summary", "demo"] });
    });
  }, 15_000);
});
