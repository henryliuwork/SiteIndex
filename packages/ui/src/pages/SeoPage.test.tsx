// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function typeSearchAt100ms(input: HTMLInputElement, value: string) {
  for (const [index] of [...value].entries()) {
    const typed = value.slice(0, index + 1);
    fireEvent.change(input, { target: { value: typed } });
    expect(input.value).toBe(typed);
    if (index < value.length - 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function expectSearchSurfaceStable(table: HTMLElement, input: HTMLInputElement) {
  expect(table.isConnected).toBe(true);
  expect(table.contains(input)).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("abc");
}

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
          {column.cell ? column.cell({ row: { original: row, index: rowIndex } } as never) : String(row[column.accessorKey ?? ""] ?? "")}
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
  it("搜索占位文案适配窄工具栏宽度", async () => {
    await renderSeoPage(createMockApi());

    const table = await screen.findByRole("table", { name: "seo.issues.v2 数据表" });
    const input = within(table).getByRole("searchbox", { name: "搜索 SEO 数据" }) as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBe("搜索 URL 或标题");
  });

  it("待处理问题数列按高优先级问题数排序", async () => {
    const [{ DataTable }, { seoPageTableColumns }] = await Promise.all([
      import("../components/table"),
      import("./seo/page-table"),
    ]);
    const page = await createMockApi().seo.listPageRows!("demo", { page: 1, pageSize: 50 });
    const onQueryChange = vi.fn();
    render(<DataTable
      tableId="seo.pageRows.sort-audit"
      rows={page.rows.slice(0, 2)}
      total={2}
      columns={seoPageTableColumns(page.rows)}
      query={{ page: 1, pageSize: 50, filters: {} }}
      onQueryChange={onQueryChange}
      getRowId={(row) => row.url}
      height={300}
      showPagination={false}
    />);

    fireEvent.click(screen.getByRole("button", { name: "待处理问题" }));
    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ sort: { field: "open_high", dir: "asc" } })));
  });

  it.each([0, 300, 1000])("SEO 兼容问题列表延迟 %ims 时搜索框保持挂载、焦点与 abc", async (delayMs) => {
    const mockApi = createMockApi();
    const originalListIssues = mockApi.seo.listIssues.bind(mockApi.seo);
    let searchSettled = false;
    const listIssues = vi.fn(async (projectId, query) => {
      if (!query.search) return originalListIssues(projectId, query);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = await originalListIssues(projectId, query);
      searchSettled = true;
      return result;
    });
    mockApi.seo.listIssues = listIssues;
    await renderSeoPage(mockApi, "/p/demo/seo", false);
    const table = await screen.findByRole("table", { name: "seo.issues.v2 数据表" });
    const input = within(table).getByRole("searchbox", { name: "搜索 SEO 数据" }) as HTMLInputElement;
    input.focus();
    await typeSearchAt100ms(input, "abc");
    await waitFor(() => expect(listIssues).toHaveBeenCalledWith("demo", expect.objectContaining({ search: "abc" })));

    if (delayMs > 0) expect(searchSettled).toBe(false);
    expectSearchSurfaceStable(table, input);
    await waitFor(() => expect(searchSettled).toBe(true), { timeout: delayMs + 1500 });
    expectSearchSurfaceStable(table, input);
  });

  it.each([0, 300, 1000])("SEO 聚合页面表延迟 %ims 时搜索框保持挂载、焦点与 abc", async (delayMs) => {
    const mockApi = createMockApi();
    const originalListPageRows = mockApi.seo.listPageRows!.bind(mockApi.seo);
    let searchSettled = false;
    const listPageRows = vi.fn(async (projectId, query) => {
      if (!query.search) return originalListPageRows(projectId, query);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = await originalListPageRows(projectId, query);
      searchSettled = true;
      return result;
    });
    mockApi.seo.listPageRows = listPageRows;
    await renderSeoPage(mockApi, "/p/demo/seo", true);
    const table = await screen.findByRole("table", { name: "seo.pageRows 数据表" });
    const input = within(table).getByRole("searchbox", { name: "搜索 SEO 页面" }) as HTMLInputElement;
    input.focus();
    await typeSearchAt100ms(input, "abc");
    await waitFor(() => expect(listPageRows).toHaveBeenCalledWith("demo", expect.objectContaining({ search: "abc" })));

    if (delayMs > 0) expect(searchSettled).toBe(false);
    expectSearchSurfaceStable(table, input);
    await waitFor(() => expect(searchSettled).toBe(true), { timeout: delayMs + 1500 });
    expectSearchSurfaceStable(table, input);
  });

  it.each(((["pages", "links"] as const).flatMap((view) => [0, 300, 1000].map((delayMs) => ({ view, delayMs })))))(
    "SEO 兼容 $view 视图延迟 $delayMs ms 时搜索框保持挂载、焦点与 abc",
    async ({ view, delayMs }) => {
      const mockApi = createMockApi();
      let searchSettled = false;
      if (view === "pages") {
        const original = mockApi.seo.listPages.bind(mockApi.seo);
        mockApi.seo.listPages = vi.fn(async (projectId, query) => {
          if (!query.search) return original(projectId, query);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const result = await original(projectId, query);
          searchSettled = true;
          return result;
        });
      } else {
        const original = mockApi.seo.listLinks.bind(mockApi.seo);
        mockApi.seo.listLinks = vi.fn(async (projectId, query) => {
          if (!query.search) return original(projectId, query);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const result = await original(projectId, query);
          searchSettled = true;
          return result;
        });
      }

      await renderSeoPage(mockApi, "/p/demo/seo", false);
      const viewGroup = await screen.findByRole("group", { name: "SEO 视图" });
      if (view === "pages") fireEvent.click(within(viewGroup).getByRole("button", { name: /页面/ }));
      else fireEvent.click(within(viewGroup).getByRole("button", { name: /内链/ }));
      const table = await screen.findByRole("table", { name: `seo.${view} 数据表` });
      const input = within(table).getByRole("searchbox", { name: "搜索 SEO 数据" }) as HTMLInputElement;
      input.focus();
      await typeSearchAt100ms(input, "abc");

      const searchMethod = view === "pages" ? mockApi.seo.listPages : mockApi.seo.listLinks;
      await waitFor(() => expect(searchMethod).toHaveBeenCalledWith("demo", expect.objectContaining({ search: "abc" })));
      if (delayMs > 0) expect(searchSettled).toBe(false);
      expectSearchSurfaceStable(table, input);
      await waitFor(() => expect(searchSettled).toBe(true), { timeout: delayMs + 1500 });
      expectSearchSurfaceStable(table, input);
    },
  );

  it("SEO 抓取日期只显示在数据说明行，项目头和页底不重复", async () => {
    await renderSeoPage(createMockApi());

    const dateNote = await screen.findByText(/SEO 抓取数据截至/);
    const frame = document.querySelector(".si-page-frame-project.is-table");
    expect(frame).toBeTruthy();
    expect(frame?.querySelector(".si-page-frame-header .si-project-header")).toBeTruthy();
    expect(frame?.querySelector(".si-page-frame-body .si-tab-panel")).toBeTruthy();
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
  it.each(["new", "unindexed"] as const)("从概览恢复 %s 页面摘要筛选", async (summary) => {
    const mockApi = createMockApi();
    const listPageRows = vi.spyOn(mockApi.seo, "listPageRows");
    await renderSeoPage(mockApi, `/p/demo/seo?summary=${summary}`, true);
    await waitFor(() => expect(listPageRows).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ summary }),
    })));
    expect(screen.getByTestId("search-params").textContent).toBe(`?summary=${summary}`);
  });

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
    const summary = await screen.findByRole("group", { name: "SEO 摘要" });
    for (const label of ["待处理问题页", "本次新增", "未收录", "已修复"]) {
      expect(within(summary).getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(await screen.findByRole("button", { name: "数据来源时间" })).toBeTruthy();
    expect(screen.queryByText(/SEO 抓取数据截至/)).toBeNull();
    for (const [label, value] of [["待处理问题页", "open"], ["本次新增", "new"], ["未收录", "unindexed"], ["已修复", "fixed"]] as const) {
      fireEvent.click(within(summary).getByRole("button", { name: new RegExp(label) }));
      await waitFor(() => expect(screen.getByTestId("search-params").textContent).toContain(`summary=${value}`));
      await waitFor(() => expect(listPageRows).toHaveBeenCalledWith("demo", expect.objectContaining({
        filters: expect.objectContaining({ summary: value }),
      })));
      fireEvent.click(within(summary).getByRole("button", { name: new RegExp(label) }));
      await waitFor(() => expect(screen.getByTestId("search-params").textContent).not.toContain("summary="));
    }

    const compactSummary = document.querySelector<HTMLButtonElement>(".si-seo-compact-summary-filter button");
    expect(compactSummary).toBeTruthy();
    fireEvent.click(compactSummary!);
    const compactOptions = document.querySelector<HTMLElement>('.si-seo-dropdown-options[aria-label="SEO 摘要"]');
    expect(compactOptions).toBeTruthy();
    fireEvent.click(within(compactOptions!).getByRole("button", { name: /本次新增/ }));
    await waitFor(() => expect(listPageRows).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ summary: "new" }),
    })));
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
