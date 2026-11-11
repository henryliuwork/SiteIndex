// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { EdmSkuIndexExportResult, JobProgress, JobResult, RunLog, SiteIndexApi, SkuImageRow } from "@siteindex/shared";
import { createMockApi } from "../mock";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.doUnmock("../api");
  vi.doUnmock("@siteindex/shared");
  vi.restoreAllMocks();
  vi.resetModules();
});

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname + location.search}</output>
    <button type="button" onClick={() => navigate("/p/demo/runs")}>离开 EDM</button>
    <button type="button" onClick={() => navigate("/p/demo/edm")}>返回 EDM</button>
    <button type="button" onClick={() => navigate("/p/other/edm")}>切换项目</button>
  </>;
}

type EdmPageTestOptions = {
  history?: RunLog[];
  historyByProject?: Record<string, RunLog[]>;
  exportReady?: boolean;
  exportResult?: EdmSkuIndexExportResult;
  exportError?: unknown;
  mediaPrepareError?: unknown;
};

async function renderEdmPage(groupingEnabled: boolean, mockMode = true, imageRows?: SkuImageRow[], mediaReady = false, deferredMediaPrepare = false, options: EdmPageTestOptions = {}) {
  const mockApi = createMockApi();
  const project = await mockApi.projects.get("demo");
  mockApi.projects.get = vi.fn(async (projectId) => ({
    ...project,
    summary: { ...project.summary, id: projectId },
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
  mockApi.jobs.history = vi.fn(async (projectId) => options.historyByProject?.[projectId] ?? options.history ?? []);
  const exportIndex = vi.fn(async (): Promise<EdmSkuIndexExportResult> => {
    if (options.exportError) throw options.exportError;
    return options.exportResult ?? { status: "created", path: "index/edm/sku-index.md", sku_count: 1, missing_image_count: 0 };
  });
  if (options.exportReady) mockApi.edm.exportIndex = exportIndex;
  let resolvePendingMediaPrepare: ((run: { runId: string }) => void) | undefined;
  const mediaPrepare = deferredMediaPrepare
    ? vi.fn(() => new Promise<{ runId: string }>((resolve) => { resolvePendingMediaPrepare = resolve; }))
    : vi.fn(async () => {
      if (options.mediaPrepareError) throw options.mediaPrepareError;
      return { runId: "demo-media-run" };
    });
  let onMediaProgress: ((progress: JobProgress) => void) | undefined;
  let onMediaFinished: ((result: JobResult) => void) | undefined;
  let activeProgressSubscriptions = 0;
  let activeFinishedSubscriptions = 0;
  if (mediaReady || options.exportReady) {
    vi.doMock("@siteindex/shared", async () => {
      const actual = await vi.importActual<typeof import("@siteindex/shared")>("@siteindex/shared");
      return { ...actual, PENDING_HANDLERS: [] };
    });
    mockApi.media = { prepare: mediaPrepare };
    mockApi.jobs.onProgress = (callback) => {
      activeProgressSubscriptions += 1;
      onMediaProgress = callback;
      return () => { activeProgressSubscriptions -= 1; if (onMediaProgress === callback) onMediaProgress = undefined; };
    };
    mockApi.jobs.onFinished = (callback) => {
      activeFinishedSubscriptions += 1;
      onMediaFinished = callback;
      return () => { activeFinishedSubscriptions -= 1; if (onMediaFinished === callback) onMediaFinished = undefined; };
    };
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
          <Route path="/p/:id/runs" element={<div>运行页面</div>} />
          <Route path="/p/:id/settings/config" element={<div>项目设置页</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
    </ToastProvider>,
  );
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  return {
    mockApi, listImages, previewGrouping, setManualImage, mediaPrepare, exportIndex, invalidateQueries,
    emitMediaProgress: (progress: JobProgress) => onMediaProgress?.(progress),
    emitMediaFinished: (result: JobResult) => onMediaFinished?.(result),
    resolveMediaPrepare: (runId = "demo-media-run") => resolvePendingMediaPrepare?.({ runId }),
    setHistoryData: (projectId: string, runs: RunLog[]) => queryClient.setQueryData(["job-history", projectId], runs),
    activeSubscriptions: () => ({ progress: activeProgressSubscriptions, finished: activeFinishedSubscriptions }),
  };
}

async function openMediaDemo() {
  fireEvent.click(await screen.findByRole("button", { name: "交互模拟（仅本地演示，不会上传或写入台账）" }));
}

function exportControlFor(button: HTMLElement): HTMLElement {
  const control = button.closest(".si-edm-export-control");
  if (!(control instanceof HTMLElement)) throw new Error("导出控制区未渲染");
  return control;
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

  it("SKU 清单导出契约和后端未就绪时不显示导出入口", async () => {
    await renderEdmPage(true);

    expect(await screen.findByRole("button", { name: "复制 edm-builder 指令" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /导出.*清单/ })).toBeNull();
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

  it("清单原型默认完整范围，所选范围隔离输出并演示幂等重生成", async () => {
    const rows = [
      mediaImageRow("DEMO-EXPORT-001", "https://demo-store.example.test/demo/one.jpg"),
      mediaImageRow("DEMO-EXPORT-002", "https://demo-store.example.test/demo/two.jpg"),
    ];
    await renderEdmPage(true, true, rows);
    await openMediaDemo();
    fireEvent.click(screen.getByText("展开 EDM 导出与重启恢复原型（仅本地 mock）"));

    const fullScope = screen.getByRole("radio", { name: /全项目 SKU/ });
    const selectedScope = screen.getByRole("radio", { name: /当前选中 SKU/ });
    expect(fullScope.hasAttribute("checked") || (fullScope as HTMLInputElement).checked).toBe(true);
    expect(selectedScope.parentElement?.textContent).toContain("未来设想");
    expect(selectedScope.parentElement?.textContent).toContain("未确认");
    expect((selectedScope as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    expect((selectedScope as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(selectedScope);
    fireEvent.click(screen.getByRole("button", { name: "预览未来所选 SKU 副本（未确认，2）" }));
    expect(screen.getByText(/未来设想（尚未确认）：仅包含当前选择的 2 个 SKU/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认模拟" }));
    expect(await screen.findByText(/未来设想预览了 2 个 SKU 的独立副本；不影响全项目清单，也没有写入文件/)).toBeTruthy();

    fireEvent.click(fullScope);
    fireEvent.click(screen.getByRole("button", { name: "生成完整清单（模拟）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认模拟" }));
    expect(await screen.findByText(/全项目清单首次生成完成。演示没有写入文件/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更新完整清单（模拟）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认模拟" }));
    expect(await screen.findByText(/重复生成且内容未变化/)).toBeTruthy();
  }, 15_000);

  it.each([
    ["interrupted", "应用关闭时中断", "中断时状态未知", "尚未开始"],
    ["permission-stopped", "403 权限错误后停止", "WordPress 权限不足（403），批次已停止", "尚未开始"],
  ] as const)("重启恢复原型展示 %s 的逐 SKU 状态与项目归属", async (scenario, option, result, unstarted) => {
    await renderEdmPage(true);
    await openMediaDemo();
    fireEvent.click(screen.getByText("展开 EDM 导出与重启恢复原型（仅本地 mock）"));
    if (scenario !== "interrupted") {
      fireEvent.click(screen.getByRole("combobox", { name: "模拟恢复场景" }));
      fireEvent.click(await screen.findByRole("option", { name: option }));
    }
    fireEvent.click(screen.getByRole("button", { name: "模拟重启并恢复结果" }));

    const recovery = await screen.findByRole("region", { name: "重启恢复原型结果" });
    expect(within(recovery).getByText(/恢复归属项目：/)).toBeTruthy();
    expect(within(recovery).getByText(result)).toBeTruthy();
    expect(within(recovery).getAllByText(unstarted)).toHaveLength(2);
    expect(within(recovery).getByRole("list", { name: "恢复逐 SKU 结果示例" })).toBeTruthy();
  }, 15_000);

  it("切换项目后重置清单与恢复原型状态及所选 SKU", async () => {
    const rows = [mediaImageRow("DEMO-PROJECT-SWITCH-001", "https://demo-store.example.test/demo/one.jpg")];
    await renderEdmPage(true, true, rows);
    await openMediaDemo();
    fireEvent.click(screen.getByText("展开 EDM 导出与重启恢复原型（仅本地 mock）"));
    fireEvent.click(screen.getByRole("button", { name: "生成完整清单（模拟）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认模拟" }));
    expect(await screen.findByText(/全项目清单首次生成完成/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "模拟重启并恢复结果" }));
    expect(await screen.findByRole("region", { name: "重启恢复原型结果" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(screen.getByRole("radio", { name: /当前选中 SKU/ }));

    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/p/other/edm"));
    fireEvent.click(await screen.findByText("展开 EDM 导出与重启恢复原型（仅本地 mock）"));

    const fullScope = screen.getByRole("radio", { name: /全项目 SKU/ });
    const selectedScope = screen.getByRole("radio", { name: /当前选中 SKU/ });
    expect((fullScope as HTMLInputElement).checked).toBe(true);
    expect((selectedScope as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "生成完整清单（模拟）" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "重启恢复原型结果" })).toBeNull();
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

  it("图片准备被版本门禁关闭时说明暂未开放，不渲染可执行按钮", async () => {
    await renderEdmPage(true, false);
    expect(await screen.findByText(/当前版本暂未开放图片准备功能/)).toBeTruthy();
    expect(screen.getByText("图片准备暂未开放", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText("展开 EDM 导出与重启恢复原型（仅本地 mock）")).toBeNull();
    expect(screen.queryByRole("button", { name: /模拟获取图片 URL|获取图片 URL/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "选择当前页全部行" })).toBeNull();
  });

  it("真实模式在 Core/Desktop 导出门禁仍关闭时不渲染可执行清单导出按钮", async () => {
    await renderEdmPage(true, false);

    expect(await screen.findByText(/全项目 SKU 清单导出尚未就绪/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "导出全项目 SKU 清单" })).toBeNull();
  });

  it("导出契约与 IPC 就绪后调用全项目方法并按返回状态显示相对路径", async () => {
    const result: EdmSkuIndexExportResult = {
      status: "updated", path: "_site-index/edm/sku-index.md", sku_count: 12, missing_image_count: 3,
    };
    const { exportIndex } = await renderEdmPage(true, false, undefined, false, false, { exportReady: true, exportResult: result });
    const button = await screen.findByRole("button", { name: "导出全项目 SKU 清单" });
    fireEvent.click(button);

    await waitFor(() => expect(exportIndex).toHaveBeenCalledWith("demo"));
    const control = exportControlFor(button);
    expect(await within(control).findByText(/清单已更新：12 个 SKU，待补图 3 个/)).toBeTruthy();
    expect(within(control).getByText("_site-index/edm/sku-index.md")).toBeTruthy();
  });

  it("导出确认结果未知时明确提示可能已写入并保持重试禁用", async () => {
    const unknownError = Object.assign(new Error("写入确认超时"), { code: "EDM_EXPORT_OUTCOME_UNKNOWN" });
    const { exportIndex } = await renderEdmPage(true, false, undefined, false, false, { exportReady: true, exportError: unknownError });
    const button = await screen.findByRole("button", { name: "导出全项目 SKU 清单" });
    fireEvent.click(button);

    const control = exportControlFor(button);
    expect(await within(control).findByText(/写入结果尚未确认；清单可能已经生成/)).toBeTruthy();
    expect(within(control).getByText(/此页面不会盲目重试/)).toBeTruthy();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    expect(exportIndex).toHaveBeenCalledTimes(1);
  });

  it("本机已有结果未知标记时跨页面进入仍禁用导出", async () => {
    window.localStorage.setItem("siteindex:edm-export-attempt:demo", "unknown");
    const { exportIndex } = await renderEdmPage(true, false, undefined, false, false, { exportReady: true });
    const button = await screen.findByRole("button", { name: "导出全项目 SKU 清单" });

    expect(button.hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/在后端提供并验证每次调用前的完整核验前/)).toBeTruthy();
    fireEvent.click(button);
    expect(exportIndex).not.toHaveBeenCalled();
  });

  it("无法持久化导出门闩时不调用 IPC，并提供本机恢复路径", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const { exportIndex } = await renderEdmPage(true, false, undefined, false, false, { exportReady: true });
    fireEvent.click(await screen.findByRole("button", { name: "导出全项目 SKU 清单" }));

    expect(await screen.findAllByText(/请求尚未发送，导出操作已暂停/)).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "导出全项目 SKU 清单" }).hasAttribute("disabled")).toBe(true);
    expect(exportIndex).not.toHaveBeenCalled();
  });

  it("清单目标冲突时明确说明没有覆盖已有文件", async () => {
    const conflictError = Object.assign(new Error("目标内容冲突"), { code: "EDM_INDEX_CONFLICT" });
    const { exportIndex } = await renderEdmPage(true, false, undefined, false, false, { exportReady: true, exportError: conflictError });
    const button = await screen.findByRole("button", { name: "导出全项目 SKU 清单" });
    fireEvent.click(button);

    const control = exportControlFor(button);
    expect(await within(control).findByText(/目标存在冲突，未覆盖已有文件/)).toBeTruthy();
    expect(exportIndex).toHaveBeenCalledWith("demo");
  });

  it("进入 EDM 页后恢复最新媒体历史；旧字段缺失时不推断未开始", async () => {
    const legacyRun: RunLog = {
      run_id: "old-media-run", job: "media", started_at: "2026-11-10T10:00:00.000Z", finished_at: "2026-11-10T10:01:00.000Z", status: "partial",
      media_error_code: "WP_AUTH_FAILED",
    };
    const { mockApi } = await renderEdmPage(true, false, undefined, false, false, { history: [legacyRun] });

    expect(await screen.findByText(/旧版任务记录没有逐 SKU 恢复字段/)).toBeTruthy();
    expect(screen.getByText(/WordPress 认证失败（401），媒体批次已停止/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "最近任务逐 SKU 恢复结果" })).toBeNull();
    expect(mockApi.jobs.history).toHaveBeenCalledWith("demo", 100);
    expect(screen.queryByText("已确认未开始")).toBeNull();
    expect(screen.getByText(/最近 100 条任务记录（包含所有任务类型）/)).toBeTruthy();
  });

  it("按恢复契约显示结果未知、已确认未开始与认证停批码", async () => {
    const interruptedRun: RunLog = {
      run_id: "media-403-run", job: "media", started_at: "2026-11-10T10:00:00.000Z", finished_at: "2026-11-10T10:01:00.000Z", status: "partial",
      media_requested_skus: ["DEMO-RECOVER-001", "DEMO-RECOVER-002", "DEMO-RECOVER-003"],
      media_batch_state: "outcome_unknown",
      media_results: [{ sku: "DEMO-RECOVER-001", status: "failed", reason: "虚构 403 错误" }],
      media_unknown_skus: ["DEMO-RECOVER-002"],
      media_not_started_skus: ["DEMO-RECOVER-003"],
      media_error_code: "WP_FORBIDDEN",
    };
    await renderEdmPage(true, false, undefined, false, false, { history: [interruptedRun] });

    expect(await screen.findByText(/WordPress 权限不足（403），媒体批次已停止/)).toBeTruthy();
    const results = await screen.findByRole("list", { name: "最近任务逐 SKU 恢复结果" });
    expect(within(results).getByText("结果未知")).toBeTruthy();
    expect(within(results).getByText("已确认未开始")).toBeTruthy();
    expect(within(results).getByText("失败")).toBeTruthy();
  });

  it("媒体任务启动失败不会遮住最近已持久化的媒体历史", async () => {
    const historicalRun: RunLog = {
      run_id: "persisted-media-run", job: "media", started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date(Date.now() - 59_000).toISOString(), status: "ok",
      media_requested_skus: ["DEMO-PERSISTED-HISTORY-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-PERSISTED-HISTORY-001", status: "recorded" }], media_unknown_skus: [], media_not_started_skus: [],
    };
    const rows = [mediaImageRow("DEMO-START-FAIL-001", "https://demo-store.example.test/demo/item.webp")];
    await renderEdmPage(true, false, rows, true, false, { history: [historicalRun], mediaPrepareError: new Error("虚构 IPC 启动失败") });
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("button", { name: "获取图片 URL（1）" }));

    expect(await screen.findByRole("list", { name: "最近任务逐 SKU 恢复结果" })).toBeTruthy();
    expect(screen.getByText("DEMO-PERSISTED-HISTORY-001")).toBeTruthy();
    expect(screen.getByText("虚构 IPC 启动失败")).toBeTruthy();
  });

  it("切换项目后只恢复新项目自己的媒体历史", async () => {
    const demoRun: RunLog = {
      run_id: "demo-private-media-run", job: "media", started_at: "2026-11-10T10:00:00.000Z", finished_at: "2026-11-10T10:01:00.000Z", status: "failed",
      media_requested_skus: ["DEMO-ONLY-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-ONLY-001", status: "uploaded" }], media_unknown_skus: [], media_not_started_skus: [],
    };
    const { mockApi } = await renderEdmPage(true, false, undefined, false, false, { historyByProject: { demo: [demoRun], other: [] } });
    expect(await screen.findByText("DEMO-ONLY-001")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/p/other/edm"));

    await waitFor(() => expect(mockApi.jobs.history).toHaveBeenCalledWith("other", 100));
    expect(screen.queryByText("DEMO-ONLY-001")).toBeNull();
    expect(screen.queryByRole("region", { name: "最近一次图片处理恢复结果" })).toBeNull();
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
      media_requested_skus: ["DEMO-REAL-JPG-001", "DEMO-REAL-WEBP-001", "DEMO-REAL-WEBP-002"],
      media_batch_state: "interrupted",
      media_results: [{ sku: "DEMO-REAL-JPG-001", status: "recorded" }, { sku: "DEMO-REAL-WEBP-001", status: "failed", reason: "虚构测试错误" }],
      media_unknown_skus: [],
      media_not_started_skus: ["DEMO-REAL-WEBP-002"],
    });

    const results = await screen.findByRole("list", { name: "图片准备逐 SKU 结果" });
    expect(within(results).getByText("原图 URL 已记录")).toBeTruthy();
    expect(within(results).getByText("失败")).toBeTruthy();
    expect(within(results).getByText("已确认未开始")).toBeTruthy();
    expect(await screen.findAllByText(/WordPress 认证失败（401），媒体批次已停止/)).toHaveLength(2);
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "summary", "demo"] });
    });
  }, 15_000);

  it("finished 事件先于 prepare 返回时缓存结果，避免任务永远停在处理中", async () => {
    const rows = [mediaImageRow("DEMO-RACE-001", "https://demo-store.example.test/demo/main.webp")];
    const { mediaPrepare, resolveMediaPrepare, emitMediaFinished } = await renderEdmPage(true, false, rows, true, true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("button", { name: "获取图片 URL（1）" }));
    await waitFor(() => expect(mediaPrepare).toHaveBeenCalled());

    emitMediaFinished({
      runId: "demo-media-run", job: "media", status: "ok", exitCode: 0, summary: "图片准备完成",
      media_requested_skus: ["DEMO-RACE-001"],
      media_batch_state: "complete",
      media_results: [{ sku: "DEMO-RACE-001", status: "uploaded" }],
      media_unknown_skus: [],
      media_not_started_skus: [],
    });
    resolveMediaPrepare();

    const results = await screen.findByRole("list", { name: "图片准备逐 SKU 结果" });
    expect(within(results).getByText("已上传")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "获取图片 URL（1）" }).hasAttribute("disabled")).toBe(false));
  }, 15_000);

  it("切换项目后旧任务结果不显示在新项目，也只刷新原项目缓存", async () => {
    const rows = [mediaImageRow("DEMO-OLD-PROJECT-001", "https://demo-store.example.test/demo/main.webp")];
    const { mediaPrepare, invalidateQueries, emitMediaFinished } = await renderEdmPage(true, false, rows, true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("button", { name: "获取图片 URL（1）" }));
    await waitFor(() => expect(mediaPrepare).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/p/other/edm"));

    emitMediaFinished({
      runId: "demo-media-run", job: "media", status: "ok", exitCode: 0, summary: "图片准备完成",
      media_requested_skus: ["DEMO-OLD-PROJECT-001"],
      media_batch_state: "complete",
      media_results: [{ sku: "DEMO-OLD-PROJECT-001", status: "uploaded" }],
      media_unknown_skus: [],
      media_not_started_skus: [],
    });

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] }));
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["edm", "images", "other"] });
    expect(screen.queryByRole("list", { name: "图片准备逐 SKU 结果" })).toBeNull();
    expect(screen.queryByText("DEMO-OLD-PROJECT-001")).toBeNull();
  }, 15_000);

  it("离开 EDM 后保留进度、完成通知与原项目缓存刷新，并在返回后恢复逐 SKU 结果", async () => {
    const rows = [
      mediaImageRow("DEMO-BACKGROUND-001", "https://demo-store.example.test/demo/first.webp"),
      mediaImageRow("DEMO-BACKGROUND-002", "https://demo-store.example.test/demo/second.webp"),
    ];
    const { mediaPrepare, invalidateQueries, emitMediaProgress, emitMediaFinished, activeSubscriptions } = await renderEdmPage(true, false, rows, true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("button", { name: "获取图片 URL（2）" }));
    await waitFor(() => expect(mediaPrepare).toHaveBeenCalledWith({ project: "demo", skus: ["DEMO-BACKGROUND-001", "DEMO-BACKGROUND-002"] }));
    expect(activeSubscriptions()).toEqual({ progress: 1, finished: 1 });

    fireEvent.click(screen.getByRole("button", { name: "离开 EDM" }));
    expect(await screen.findByText("运行页面")).toBeTruthy();
    emitMediaProgress({ runId: "demo-media-run", projectPath: "C:/fake/demo", job: "media", pct: 70, level: "info", message: "正在处理虚构 SKU", at: "2026-11-11T00:00:00.000Z" });
    expect(await screen.findByText(/图片处理进度（.*）：正在处理虚构 SKU/)).toBeTruthy();
    emitMediaFinished({
      runId: "demo-media-run", job: "media", status: "partial", exitCode: 1, summary: "有 1 个 SKU 处理失败",
      media_requested_skus: ["DEMO-BACKGROUND-001", "DEMO-BACKGROUND-002"],
      media_batch_state: "complete",
      media_results: [
        { sku: "DEMO-BACKGROUND-001", status: "uploaded" },
        { sku: "DEMO-BACKGROUND-002", status: "failed", reason: "虚构测试错误" },
      ],
      media_unknown_skus: [],
      media_not_started_skus: [],
    });

    expect(await screen.findByText(/图片 URL 已部分处理，请检查逐 SKU 结果。/)).toBeTruthy();
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "summary", "demo"] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["job-history", "demo"] });
    });
    expect(activeSubscriptions()).toEqual({ progress: 0, finished: 0 });

    fireEvent.click(screen.getByRole("button", { name: "返回 EDM" }));
    const results = await screen.findByRole("list", { name: "图片准备逐 SKU 结果" });
    expect(within(results).getByText("DEMO-BACKGROUND-001")).toBeTruthy();
    expect(within(results).getByText("已上传")).toBeTruthy();
    expect(within(results).getByText("DEMO-BACKGROUND-002")).toBeTruthy();
    expect(within(results).getByText("虚构测试错误")).toBeTruthy();
    expect(activeSubscriptions()).toEqual({ progress: 1, finished: 1 });
  }, 15_000);

  it("返回页面时较新的外部历史覆盖旧快照，即使 runId 被复用", async () => {
    const rows = [mediaImageRow("DEMO-OLD-SNAPSHOT-001", "https://demo-store.example.test/demo/old.webp")];
    const historyByProject: Record<string, RunLog[]> = { demo: [], other: [] };
    const { mediaPrepare, emitMediaFinished } = await renderEdmPage(true, false, rows, true, false, { historyByProject });
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    fireEvent.click(await screen.findByRole("button", { name: "获取图片 URL（1）" }));
    await waitFor(() => expect(mediaPrepare).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "离开 EDM" }));
    expect(await screen.findByText("运行页面")).toBeTruthy();
    emitMediaFinished({
      runId: "demo-media-run", job: "media", status: "ok", exitCode: 0, summary: "已处理旧快照",
      media_requested_skus: ["DEMO-OLD-SNAPSHOT-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-OLD-SNAPSHOT-001", status: "uploaded" }], media_unknown_skus: [], media_not_started_skus: [],
    });
    const newerStartedAt = Date.now() + 60 * 60 * 1000;
    historyByProject.demo = [{
      run_id: "demo-media-run", job: "media", started_at: new Date(newerStartedAt).toISOString(),
      finished_at: new Date(newerStartedAt + 1000).toISOString(), status: "ok",
      media_requested_skus: ["DEMO-EXTERNAL-NEWER-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-EXTERNAL-NEWER-001", status: "recorded" }], media_unknown_skus: [], media_not_started_skus: [],
    }];

    fireEvent.click(screen.getByRole("button", { name: "返回 EDM" }));
    const results = await screen.findByRole("list", { name: "最近任务逐 SKU 恢复结果" });
    expect(within(results).getByText("DEMO-EXTERNAL-NEWER-001")).toBeTruthy();
    expect(within(results).queryByText("DEMO-OLD-SNAPSHOT-001")).toBeNull();
  }, 15_000);

  it("当前窗口接到另一窗口的媒体完成事件后刷新历史、摘要和图片列表", async () => {
    const historyByProject: Record<string, RunLog[]> = { demo: [] };
    const { mockApi, invalidateQueries, emitMediaFinished } = await renderEdmPage(true, false, undefined, true, false, { historyByProject });
    await waitFor(() => expect(mockApi.jobs.history).toHaveBeenCalledWith("demo", 100));
    const externalStartedAt = Date.now();
    historyByProject.demo = [{
      run_id: "external-media-run", job: "media", started_at: new Date(externalStartedAt).toISOString(),
      finished_at: new Date(externalStartedAt + 1000).toISOString(), status: "ok",
      media_requested_skus: ["DEMO-OTHER-WINDOW-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-OTHER-WINDOW-001", status: "recorded" }], media_unknown_skus: [], media_not_started_skus: [],
    }];

    emitMediaFinished({
      runId: "external-media-run", job: "media", status: "ok", exitCode: 0, summary: "媒体处理完成",
      media_requested_skus: ["DEMO-OTHER-WINDOW-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-OTHER-WINDOW-001", status: "recorded" }], media_unknown_skus: [], media_not_started_skus: [],
    });

    const historyResults = await screen.findByRole("list", { name: "最近任务逐 SKU 恢复结果" });
    expect(within(historyResults).getByText("DEMO-OTHER-WINDOW-001")).toBeTruthy();
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "summary", "demo"] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["job-history", "demo"] });
    });
  }, 15_000);

  it("较新的同 runId 历史可以展示，但不会隐藏活动进度或解除防重", async () => {
    const rows = [mediaImageRow("DEMO-ACTIVE-001", "https://demo-store.example.test/demo/active.webp")];
    const { mediaPrepare, emitMediaProgress, setHistoryData } = await renderEdmPage(true, false, rows, true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择当前页全部行" }));
    const button = await screen.findByRole("button", { name: "获取图片 URL（1）" });
    fireEvent.click(button);
    await waitFor(() => expect(mediaPrepare).toHaveBeenCalledWith({ project: "demo", skus: ["DEMO-ACTIVE-001"] }));
    emitMediaProgress({ runId: "demo-media-run", projectPath: "C:/fake/demo", job: "media", pct: 40, level: "info", message: "活动任务仍在处理虚构 SKU", at: new Date().toISOString() });

    const historyStartedAt = new Date(Date.now() + 30_000);
    setHistoryData("demo", [{
      run_id: "demo-media-run", job: "media", started_at: historyStartedAt.toISOString(),
      finished_at: new Date(historyStartedAt.getTime() + 1000).toISOString(), status: "ok",
      media_requested_skus: ["DEMO-EXTERNAL-NEWER-001"], media_batch_state: "complete",
      media_results: [{ sku: "DEMO-EXTERNAL-NEWER-001", status: "recorded" }], media_unknown_skus: [], media_not_started_skus: [],
    }]);

    const historyResults = await screen.findByRole("list", { name: "最近任务逐 SKU 恢复结果" });
    expect(within(historyResults).getByText("DEMO-EXTERNAL-NEWER-001")).toBeTruthy();
    expect(await screen.findByText("活动任务仍在处理虚构 SKU")).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);
  }, 15_000);
});
