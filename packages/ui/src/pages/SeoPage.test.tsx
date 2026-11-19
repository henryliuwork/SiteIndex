// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { createMockApi } from "../mock";

vi.setConfig({ testTimeout: 15_000 });

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
  vi.doUnmock("../components/table");
  vi.restoreAllMocks();
  vi.resetModules();
});

function SearchProbe() {
  const location = useLocation();
  return <output data-testid="search-params">{location.search}</output>;
}

async function renderSeoPage(mockApi: ReturnType<typeof createMockApi>, route = "/p/demo/seo", pageTable = false) {
  if (!pageTable) delete mockApi.seo.listPageRows;
  vi.doMock("../api", () => ({
    api: mockApi,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  vi.doMock("../components/table", () => ({
    DataTable: ({ rows, columns, tableId, selectable, onSelectionChange, toolbar }: {
      rows: Array<Record<string, unknown>>;
      columns: Array<{ id?: string; accessorKey?: string; cell?: (context: never) => React.ReactNode }>;
      tableId: string;
      selectable?: boolean;
      onSelectionChange?: (rows: Array<Record<string, unknown>>) => void;
      toolbar?: React.ReactNode;
    }) => <div aria-label={`${tableId} 数据表`} role="table">
      {toolbar}
      {rows.slice(0, 1).map((row, rowIndex) => <div role="row" key={`${tableId}-${rowIndex}`}>
        {selectable && <input type="checkbox" aria-label={`选择第 ${rowIndex + 1} 行`} onChange={() => onSelectionChange?.([row])} />}
        {columns.map((column, columnIndex) => <div role="cell" key={column.id ?? column.accessorKey ?? columnIndex}>
          {column.cell ? column.cell({ row: { original: row } } as never) : String(row[column.accessorKey ?? ""] ?? "")}
        </div>)}
      </div>)}
    </div>,
  }));
  const [{ SeoPage }, { ToastProvider }] = await Promise.all([import("./SeoPage"), import("../components/overlays")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes><Route path="/p/:id/seo" element={<SeoPage />} /></Routes>
          <SearchProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SeoPage 问题处理", () => {
  it("SEO 抓取日期只显示在数据说明行，项目头和页底不重复", async () => {
    await renderSeoPage(createMockApi());

    const dateNote = await screen.findByText(/SEO 抓取数据截至/);
    expect(dateNote.classList.contains("si-seo-data-date")).toBe(true);
    expect(dateNote.closest(".si-tab-panel")).toBeTruthy();
    expect(screen.queryByText(/最近抓取：|收录数据最后检查/)).toBeNull();
    expect(screen.queryByText(/周一 03:00/)).toBeNull();
  });

  it("setIssueStatus 缺失时不渲染处理操作，也不报错", async () => {
    const mockApi = createMockApi();
    delete mockApi.seo.setRuleIgnored;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderSeoPage(mockApi);

    expect(await screen.findByRole("table", { name: "seo.issues.v2 数据表" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /问题操作：/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /批量处理当前筛选结果/ })).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("接口可选方法缺失时隐藏对应操作菜单项", async () => {
    const mockApi = createMockApi();
    mockApi.seo.setIssueStatus = vi.fn(async () => ({ updated: 0 }));
    delete mockApi.seo.setRuleIgnored;
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByRole("button", { name: /问题操作：/ }))[0]!);
    expect(await screen.findByRole("menuitem", { name: "标记已处理" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "忽略此页面此问题" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "忽略此类问题" })).toBeNull();
  });

  it("仅提供规则忽略 IPC 时隐藏单条状态操作", async () => {
    const mockApi = createMockApi();
    mockApi.seo.setRuleIgnored = vi.fn(async () => ({ updated: 1 }));
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByRole("button", { name: /问题操作：/ }))[0]!);
    expect(screen.queryByRole("menuitem", { name: "标记已处理" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "忽略此页面此问题" })).toBeNull();
    expect(await screen.findByRole("menuitem", { name: "忽略此类问题" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /批量处理当前筛选结果/ })).toBeNull();
  });

  it("行操作弹出范围确认并更新单条问题", async () => {
    const mockApi = createMockApi();
    const setIssueStatus = vi.fn(async (_id: string, input: { targets: { url: string; rule: string }[] }) => ({ updated: input.targets.length }));
    mockApi.seo.setIssueStatus = setIssueStatus;
    mockApi.seo.setRuleIgnored = vi.fn(async () => ({ updated: 0 }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const queryClient = await renderSeoPage(mockApi);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click((await screen.findAllByRole("button", { name: /问题操作：/ }))[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "标记已处理" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：单条 SEO 问题"));
    await waitFor(() => expect(setIssueStatus).toHaveBeenCalledWith("demo", expect.objectContaining({ status: "fixed", targets: [expect.objectContaining({ rule: expect.any(String) })] })));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "summary", "demo"] })));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "issues", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "pageBrief", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "issueCandidates", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["overview", "demo"] }));
    expect(await screen.findByText("已更新 1 条")).toBeTruthy();
  });

  it("忽略单页问题前确认页面范围", async () => {
    const mockApi = createMockApi();
    const setIssueStatus = vi.fn(async () => ({ updated: 1 }));
    mockApi.seo.setIssueStatus = setIssueStatus;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByRole("button", { name: /问题操作：/ }))[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "忽略此页面此问题" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：此页面的这条 SEO 问题"));
    await waitFor(() => expect(setIssueStatus).toHaveBeenCalledWith("demo", expect.objectContaining({ status: "ignored", targets: [expect.objectContaining({ url: expect.any(String), rule: expect.any(String) })] })));
    expect(await screen.findByText("已更新 1 条")).toBeTruthy();
  });

  it("按规则忽略前确认全站范围并刷新计数", async () => {
    const mockApi = createMockApi();
    const setRuleIgnored = vi.fn(async () => ({ updated: 3 }));
    mockApi.seo.setRuleIgnored = setRuleIgnored;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByRole("button", { name: /问题操作：/ }))[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "忽略此类问题" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：全站同一规则"));
    await waitFor(() => expect(setRuleIgnored).toHaveBeenCalledWith("demo", expect.any(String), true));
    expect(await screen.findByText("已更新 3 条")).toBeTruthy();
  });

  it("批量处理显示当前筛选数量并确认该数量", async () => {
    const mockApi = createMockApi();
    const setIssueStatus = vi.fn(async (_id: string, input: { targets: { url: string; rule: string }[] }) => ({ updated: input.targets.length }));
    mockApi.seo.setIssueStatus = setIssueStatus;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSeoPage(mockApi, "/p/demo/seo?status=open");

    await waitFor(() => expect(screen.getByText(/显示 [1-9]\d* \/ [1-9]\d* 条/)).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    const bulkButton = await screen.findByRole("menuitem", { name: /批量处理当前筛选结果/ });
    const count = Number(bulkButton.textContent?.match(/（(\d+) 条）/)?.[1]);
    expect(count).toBeGreaterThan(0);
    fireEvent.click(bulkButton);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(`中的 ${count} 条`));
    await waitFor(() => expect(setIssueStatus).toHaveBeenCalledWith("demo", expect.objectContaining({ status: "fixed", targets: expect.any(Array) })));
    expect((setIssueStatus.mock.calls[0]?.[1] as { targets: unknown[] }).targets).toHaveLength(count);
    expect(await screen.findByText(`已更新 ${count} 条`)).toBeTruthy();
  });

  it("筛选结果为零时禁用批量处理", async () => {
    const emptyApi = createMockApi();
    emptyApi.seo.setIssueStatus = vi.fn(async () => ({ updated: 0 }));
    emptyApi.seo.listIssues = vi.fn(async () => ({ rows: [], total: 0 }));
    await renderSeoPage(emptyApi, "/p/demo/seo?status=open");
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect((await screen.findByRole("menuitem", { name: /批量处理当前筛选结果（0 条）/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("状态筛选写入 URL 并驱动真实列表查询", async () => {
    const mockApi = createMockApi();
    const listIssues = vi.spyOn(mockApi.seo, "listIssues");
    await renderSeoPage(mockApi, "/p/demo/seo?rule=desc_missing&status=open");

    fireEvent.click(await screen.findByRole("button", { name: "状态：待处理" }));
    fireEvent.click(await screen.findByRole("button", { name: "已忽略" }));
    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId("search-params").textContent);
      expect(params.get("status")).toBe("ignored");
      expect(params.get("rule")).toBe("desc_missing");
    });
    await waitFor(() => expect(listIssues).toHaveBeenCalledWith("demo", expect.objectContaining({ filters: expect.objectContaining({ status: "ignored", rules: ["desc_missing"] }) })));
    expect(await screen.findByRole("button", { name: "状态：已忽略" })).toBeTruthy();
  });

  it("规则设置 Drawer 使用规则查询，方法缺失时明确提示", async () => {
    const mockApi = createMockApi();
    await renderSeoPage(mockApi);
    fireEvent.click(await screen.findByRole("button", { name: "规则设置" }));
    expect(await screen.findByText("Title 长度异常")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));

    delete mockApi.seo.getRuleSettings;
    cleanup();
    await renderSeoPage(mockApi);
    fireEvent.click(await screen.findByRole("button", { name: "规则设置" }));
    expect(await screen.findByText("当前桌面版本尚未接入 seo.getRuleSettings，请更新后重试。")).toBeTruthy();
  });

  it("选择待处理行后显示确认数量并批量更新", async () => {
    const mockApi = createMockApi();
    const setIssueStatus = vi.fn(async (_id: string, input: { targets: { url: string; rule: string }[] }) => ({ updated: input.targets.length }));
    mockApi.seo.setIssueStatus = setIssueStatus;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSeoPage(mockApi, "/p/demo/seo?status=open");

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择第 1 行" }));
    expect(await screen.findByText("已选择 1 条待处理问题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    await waitFor(() => expect(setIssueStatus).toHaveBeenCalledWith("demo", expect.objectContaining({ status: "fixed", targets: expect.any(Array) })));
    expect(await screen.findByText("已更新 1 条")).toBeTruthy();
  });
});

describe("SeoPage 单页面表", () => {
  it("用真实页面聚合查询代替问题与内链视图，并恢复旧深链", async () => {
    const mockApi = createMockApi();
    const listPageRows = vi.spyOn(mockApi.seo, "listPageRows");
    await renderSeoPage(mockApi, "/p/demo/seo?view=issues&rule=desc_missing&status=open", true);
    expect(await screen.findByRole("table", { name: "seo.pageRows 数据表" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "SEO 视图" })).toBeNull();
    expect(screen.queryByRole("table", { name: "seo.issues.v2 数据表" })).toBeNull();
    await waitFor(() => expect(listPageRows).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ rules: ["desc_missing"], status: "open" }),
    })));
    expect(screen.getByText("问题类型 · Meta description 缺失")).toBeTruthy();
  });

  it("勾选页面后按实际待处理问题数确认批量处理", async () => {
    const mockApi = createMockApi();
    const setIssueStatus = vi.fn(async (_id: string, input: { targets: unknown[] }) => ({ updated: input.targets.length }));
    mockApi.seo.setIssueStatus = setIssueStatus;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSeoPage(mockApi, "/p/demo/seo", true);
    expect(await screen.findByRole("table", { name: "seo.pageRows 数据表" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择第 1 行" }));
    expect(screen.getByText(/已选 1 页 · 待处理问题 1 条/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "标记所选页面的待处理问题" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("所选 1 个页面的 1 条待处理问题"));
    await waitFor(() => expect(setIssueStatus).toHaveBeenCalledWith("demo", expect.objectContaining({
      status: "fixed", targets: [expect.objectContaining({ rule: "http_4xx" })],
    })));
    expect(await screen.findByText("已更新 1 条")).toBeTruthy();
  });

  it("摘要四项可切换页面筛选，抓取时间只放在提示里", async () => {
    const mockApi = createMockApi();
    const listPageRows = vi.spyOn(mockApi.seo, "listPageRows");
    await renderSeoPage(mockApi, "/p/demo/seo", true);
    expect(await screen.findByRole("group", { name: "SEO 摘要" })).toBeTruthy();
    for (const label of ["待处理问题页", "本次新增", "未收录", "已修复"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "数据来源时间" })).toBeTruthy();
    expect(screen.queryByText(/SEO 抓取数据截至/)).toBeNull();
    for (const [label, value] of [["待处理问题页", "open"], ["本次新增", "new"], ["未收录", "unindexed"], ["已修复", "fixed"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      await waitFor(() => expect(screen.getByTestId("search-params").textContent).toContain(`summary=${value}`));
      await waitFor(() => expect(listPageRows).toHaveBeenCalledWith("demo", expect.objectContaining({
        filters: expect.objectContaining({ summary: value }),
      })));
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      await waitFor(() => expect(screen.getByTestId("search-params").textContent).not.toContain("summary="));
    }
  });
});

describe("SeoPage 概览跳转筛选", () => {
  it("从 rule 和 status 参数恢复问题类型并在下拉中回显选中项", async () => {
    const mockApi = createMockApi();
    const listIssues = vi.spyOn(mockApi.seo, "listIssues");
    await renderSeoPage(mockApi, "/p/demo/seo?rule=desc_missing&status=open");

    expect(await screen.findByRole("button", { name: "问题类型 · 已选 1" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "移除筛选：状态 · 待处理" })).toBeTruthy();
    await waitFor(() => expect(listIssues).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ rules: ["desc_missing"], status: "open" }),
    })));

    fireEvent.click(screen.getByRole("button", { name: "问题类型 · 已选 1" }));
    const selectedRule = await screen.findByRole("checkbox", { name: /Meta description 缺失/ });
    expect((selectedRule as HTMLInputElement).checked).toBe(true);
  });
});
