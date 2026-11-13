// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectTodosResult, SiteIndexApi } from "@siteindex/shared";
import { createMockApi } from "../../mock";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return 400;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, contentRect: { width: 800, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../../api");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderTodos(configure?: (todos: NonNullable<SiteIndexApi["todos"]>) => void, omitTodos = false) {
  const mockApi = createMockApi();
  if (configure && mockApi.todos) configure(mockApi.todos);
  if (omitTodos) mockApi.todos = undefined;
  vi.doMock("../../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
    apiErrorDetails: (error: unknown) => error instanceof Error ? { message: error.message } : null,
  }));
  const [{ ProjectTodosPage }, { ToastProvider }] = await Promise.all([
    import("../ProjectTodosPage"),
    import("../../components/overlays"),
  ]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/demo/todos"]}>
          <Routes><Route path="/p/:id/todos" element={<ProjectTodosPage />} /></Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return mockApi;
}

describe("ProjectTodosPage", () => {
  it("显示规则状态、来源、备注和操作历史", async () => {
    const mockApi = await renderTodos();
    const history = vi.spyOn(mockApi.todos!, "history");
    expect(await screen.findByRole("heading", { name: "项目待办" })).toBeTruthy();
    expect(screen.getByText("虚构演示数据")).toBeTruthy();

    fireEvent.click(await screen.findByText("页面标题需要复核"));

    expect(await screen.findByRole("heading", { name: "状态与备注" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "编辑待办备注" }) as HTMLTextAreaElement).value).toBe("等待内容负责人确认新版标题。");
    expect(screen.getByText("SEO 页面")).toBeTruthy();
    expect(screen.getByText("seoPages")).toBeTruthy();
    expect(screen.getByText("记录：https://demo-store.example.test/products/demo-item-001")).toBeTruthy();
    expect(await screen.findByText("状态：待处理 → 待复核")).toBeTruthy();
    expect(history).toHaveBeenCalledWith("demo", "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001");
  });

  it("按状态和规则文本筛选虚构待办", async () => {
    await renderTodos();
    fireEvent.click(await screen.findByRole("combobox", { name: "待办状态筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "已忽略" }));

    expect(await screen.findByText("价格历史存在日期缺口")).toBeTruthy();
    expect(screen.queryByText("库存状态与 Feed 记录不一致")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目待办" }), { target: { value: "DEMO002CP01" } });
    expect(screen.getByText("价格历史存在日期缺口")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目待办" }), { target: { value: "not-a-demo-sku" } });
    expect(await screen.findByText("没有匹配的待办")).toBeTruthy();
  });

  it("区分完整空结果与尚未运行的规则检查", async () => {
    await renderTodos((todos) => {
      todos.list = async () => ({ items: [], scan: { status: "complete", evaluated_at: "2026-11-13T08:00:00.000Z" } });
    });
    expect(await screen.findByText("当前没有待办")).toBeTruthy();
    expect(screen.queryByText("规则检查尚未运行")).toBeNull();

  });

  it("尚未运行时明确说明空列表不能证明没有待办", async () => {
    await renderTodos((todos) => {
      todos.list = async () => ({ items: [], scan: { status: "not_run", evaluated_at: null } });
    });
    expect(await screen.findByText("没有可用的检查结果")).toBeTruthy();
    expect(screen.getByText("运行一次规则检查后，可信的结果会显示在这里。")).toBeTruthy();
  });

  it.each([
    ["partial", "检查结果不完整", "暂时没有可确认的待办"],
    ["failed", "规则检查失败", "检查失败，无法确认待办状态"],
  ] as const)("%s 检查空结果显示提醒，而不是已完成状态", async (status, notice, emptyTitle) => {
    await renderTodos((todos) => {
      todos.list = async () => ({ items: [], scan: { status, evaluated_at: "2026-11-13T08:00:00.000Z" } });
    });
    expect(await screen.findByText(notice)).toBeTruthy();
    expect(screen.getByText(emptyTitle)).toBeTruthy();
    expect(screen.queryByText("当前没有待办")).toBeNull();
  });

  it("桌面待办 API 缺失时说明接线状态，不渲染假空数据", async () => {
    await renderTodos(undefined, true);

    expect(await screen.findByText("当前运行环境尚未接入项目待办")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("操作记录 API 缺失时保留待办详情并说明未接入", async () => {
    await renderTodos((todos) => { delete (todos as Partial<typeof todos>).history; });

    fireEvent.click(await screen.findByText("页面标题需要复核"));
    expect(await screen.findByText("操作记录接口尚未接入")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "编辑待办备注" }) as HTMLTextAreaElement).value).toBe("等待内容负责人确认新版标题。");
  });

  it("保存状态后刷新列表与操作记录并提示成功", async () => {
    const mockApi = await renderTodos();
    const list = vi.spyOn(mockApi.todos!, "list");
    const originalUpdate = mockApi.todos!.update.bind(mockApi.todos);
    let finishUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { finishUpdate = resolve; });
    const update = vi.spyOn(mockApi.todos!, "update").mockImplementation(async (projectId, input) => {
      await updateGate;
      return originalUpdate(projectId, input);
    });
    const history = vi.spyOn(mockApi.todos!, "history");
    fireEvent.click(await screen.findByText("页面标题需要复核"));
    const listCallsBeforeSave = list.mock.calls.length;
    const historyCallsBeforeSave = history.mock.calls.length;

    fireEvent.click(await screen.findByRole("combobox", { name: "更新待办状态" }));
    fireEvent.click(await screen.findByRole("option", { name: "已完成" }));
    fireEvent.click(screen.getByRole("button", { name: "保存状态" }));

    expect(await screen.findAllByRole("button", { name: "正在保存…" })).toHaveLength(2);
    finishUpdate();
    expect(await screen.findByText("待办状态已保存。")).toBeTruthy();
    expect(update).toHaveBeenCalledWith("demo", {
      dedupe_key: "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001",
      status: "done",
    });
    expect(await screen.findByText("状态：待复核 → 已完成")).toBeTruthy();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(listCallsBeforeSave));
    await waitFor(() => expect(history.mock.calls.length).toBeGreaterThan(historyCallsBeforeSave));
    expect(screen.getAllByText("已完成").length).toBeGreaterThanOrEqual(2);
  });

  it("保存备注后刷新操作记录并提示成功", async () => {
    const mockApi = await renderTodos();
    const list = vi.spyOn(mockApi.todos!, "list");
    const update = vi.spyOn(mockApi.todos!, "update");
    const history = vi.spyOn(mockApi.todos!, "history");
    fireEvent.click(await screen.findByText("页面标题需要复核"));
    const listCallsBeforeSave = list.mock.calls.length;
    fireEvent.change(screen.getByRole("textbox", { name: "编辑待办备注" }), { target: { value: "复核演示页面的新版标题。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));

    expect(await screen.findByText("待办备注已保存。")).toBeTruthy();
    expect(update).toHaveBeenCalledWith("demo", {
      dedupe_key: "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001",
      note: "复核演示页面的新版标题。",
    });
    expect(await screen.findByText("更新备注：复核演示页面的新版标题。")).toBeTruthy();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(listCallsBeforeSave));
    await waitFor(() => expect(history.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("状态保存失败时保留原状态并提供失败反馈", async () => {
    const mockApi = await renderTodos();
    vi.spyOn(mockApi.todos!, "update").mockRejectedValue(new Error("mock save failed"));
    fireEvent.click(await screen.findByText("页面标题需要复核"));
    fireEvent.click(await screen.findByRole("combobox", { name: "更新待办状态" }));
    fireEvent.click(await screen.findByRole("option", { name: "已完成" }));
    fireEvent.click(screen.getByRole("button", { name: "保存状态" }));

    expect(await screen.findByText("待办状态保存失败，请重试。")).toBeTruthy();
    expect(screen.getAllByText("待复核").length).toBeGreaterThan(0);
  });

  it("备注保存失败时保留草稿并提供失败反馈", async () => {
    const mockApi = await renderTodos();
    vi.spyOn(mockApi.todos!, "update").mockRejectedValue(new Error("mock note save failed"));
    fireEvent.click(await screen.findByText("页面标题需要复核"));
    const note = screen.getByRole("textbox", { name: "编辑待办备注" });
    fireEvent.change(note, { target: { value: "保留待重试的虚构备注。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));

    expect(await screen.findByText("待办备注保存失败，请重试。")).toBeTruthy();
    expect((note as HTMLTextAreaElement).value).toBe("保留待重试的虚构备注。");
  });

  it("更新 API 缺失时保留只读详情并明确提示", async () => {
    await renderTodos((todos) => { delete (todos as Partial<typeof todos>).update; });
    fireEvent.click(await screen.findByText("页面标题需要复核"));

    expect(await screen.findByText("待办编辑接口尚未接入")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "更新待办状态" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "编辑待办备注" })).toBeNull();
  });

  it("列表失败可重试，且失败不显示为无待办", async () => {
    let calls = 0;
    await renderTodos((todos) => {
      const result: ProjectTodosResult = {
        items: [],
        scan: { status: "complete", evaluated_at: "2026-11-13T08:00:00.000Z" },
      };
      todos.list = async () => {
        calls += 1;
        if (calls === 1) throw new Error("演示列表暂不可用");
        return result;
      };
    });

    expect(await screen.findByText("项目待办读取失败")).toBeTruthy();
    expect(screen.queryByText("当前没有待办")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("当前没有待办")).toBeTruthy();
  });

  it("操作记录读取失败时提供单独重试入口", async () => {
    let historyCalls = 0;
    await renderTodos((todos) => {
      todos.history = async () => {
        historyCalls += 1;
        if (historyCalls === 1) throw new Error("演示历史暂不可用");
        return [];
      };
    });

    fireEvent.click(await screen.findByText("页面标题需要复核"));
    expect(await screen.findByText("操作记录读取失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无操作记录")).toBeTruthy();
  });
});
