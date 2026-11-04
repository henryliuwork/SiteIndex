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
  vi.doUnmock("../components/table");
  vi.restoreAllMocks();
  vi.resetModules();
});

function SearchProbe() {
  const location = useLocation();
  return <output data-testid="search-params">{location.search}</output>;
}

async function renderSeoPage(mockApi: ReturnType<typeof createMockApi>, route = "/p/demo/seo") {
  vi.doMock("../api", () => ({
    api: mockApi,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  vi.doMock("../components/table", () => ({
    DataTable: ({ rows, columns, tableId }: {
      rows: Array<Record<string, unknown>>;
      columns: Array<{ id?: string; accessorKey?: string; cell?: (context: never) => React.ReactNode }>;
      tableId: string;
    }) => <div aria-label={`${tableId} 数据表`} role="table">
      {rows.slice(0, 1).map((row, rowIndex) => <div role="row" key={`${tableId}-${rowIndex}`}>
        {columns.map((column, columnIndex) => <div role="cell" key={column.id ?? column.accessorKey ?? columnIndex}>
          {column.cell ? column.cell({ row: { original: row } } as never) : String(row[column.accessorKey ?? ""] ?? "")}
        </div>)}
      </div>)}
    </div>,
  }));
  const { SeoPage } = await import("./SeoPage");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes><Route path="/p/:id/seo" element={<SeoPage />} /></Routes>
        <SearchProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SeoPage 问题处理", () => {
  it("setIssueStatus 缺失时不渲染处理操作，也不报错", async () => {
    const mockApi = createMockApi();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderSeoPage(mockApi);

    expect(await screen.findByRole("table", { name: "seo.issues.v2 数据表" })).toBeTruthy();
    expect(screen.queryByText("⋯")).toBeNull();
    expect(screen.queryByRole("button", { name: /批量处理当前筛选结果/ })).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("接口可选方法缺失时隐藏对应操作菜单项", async () => {
    const mockApi = createMockApi();
    mockApi.seo.setIssueStatus = vi.fn(async () => ({ updated: 0 }));
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByText("⋯"))[0]!);
    expect(await screen.findByRole("menuitem", { name: "标记已处理" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "忽略此页面此问题" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "忽略此类问题" })).toBeNull();
  });

  it("仅提供规则忽略 IPC 时隐藏单条状态操作", async () => {
    const mockApi = createMockApi();
    mockApi.seo.setRuleIgnored = vi.fn(async () => ({ updated: 1 }));
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByText("⋯"))[0]!);
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

    fireEvent.click((await screen.findAllByText("⋯"))[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "标记已处理" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：单条 SEO 问题"));
    await waitFor(() => expect(setIssueStatus).toHaveBeenCalledWith("demo", expect.objectContaining({ status: "fixed", targets: [expect.objectContaining({ rule: expect.any(String) })] })));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "summary", "demo"] })));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "issues", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["overview", "demo"] }));
    expect(await screen.findByText("已更新 1 条")).toBeTruthy();
  });

  it("忽略单页问题前确认页面范围", async () => {
    const mockApi = createMockApi();
    const setIssueStatus = vi.fn(async () => ({ updated: 1 }));
    mockApi.seo.setIssueStatus = setIssueStatus;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSeoPage(mockApi);

    fireEvent.click((await screen.findAllByText("⋯"))[0]!);
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

    fireEvent.click((await screen.findAllByText("⋯"))[0]!);
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
    await renderSeoPage(mockApi);

    const bulkButton = await screen.findByRole("button", { name: /批量处理当前筛选结果/ });
    await waitFor(() => expect(bulkButton.textContent).not.toContain("（0 条）"));
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
    await renderSeoPage(emptyApi);
    expect((await screen.findByRole("button", { name: /批量处理当前筛选结果（0 条）/ }) as HTMLButtonElement).disabled).toBe(true);
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
