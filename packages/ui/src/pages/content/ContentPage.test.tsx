// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { JobProgress, JobResult } from "@siteindex/shared";
import { createMockApi } from "../../mock";

function SettingsRouteMarker() {
  const location = useLocation();
  return <output data-testid="settings-location">{location.pathname + location.search}</output>;
}

afterEach(() => {
  cleanup();
  vi.doUnmock("../../api");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("ContentPage 博客重新抓取", () => {
  it.fails("搜索结果刷新时博客搜索框保持挂载与焦点", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const mockApi = createMockApi();
    const originalListBlog = mockApi.content.listBlog.bind(mockApi.content);
    const listBlog = vi.fn(async (projectId, query) => {
      if (query.search) return new Promise<Awaited<ReturnType<typeof originalListBlog>>>(() => {});
      return originalListBlog(projectId, query);
    });
    mockApi.content.listBlog = listBlog;
    vi.doMock("../../api", () => ({ api: mockApi, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ ContentPage }, { ToastProvider }] = await Promise.all([import("../ContentPage"), import("../../components")]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider>
      <MemoryRouter initialEntries={["/p/demo/content"]}><Routes><Route path="/p/:id/content" element={<ContentPage />} /></Routes></MemoryRouter>
    </ToastProvider></QueryClientProvider>);

    const table = await screen.findByRole("region", { name: "content.blog 数据表" });
    const input = within(table).getByRole("searchbox", { name: "搜索内容" });
    input.focus();
    fireEvent.change(input, { target: { value: "abc" } });
    await waitFor(() => expect(listBlog).toHaveBeenCalledWith("demo", expect.objectContaining({ search: "abc" })));

    expect({ mounted: input.isConnected, focused: document.activeElement === input }).toEqual({ mounted: true, focused: true });
  });

  it("从概览深链恢复博客问题筛选，并同步后续切换到 URL", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const mockApi = createMockApi();
    const listBlog = vi.spyOn(mockApi.content, "listBlog");
    vi.doMock("../../api", () => ({ api: mockApi, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ ContentPage }, { ToastProvider }] = await Promise.all([import("../ContentPage"), import("../../components")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ToastProvider>
      <MemoryRouter initialEntries={["/p/demo/content?issue=no_schema"]}>
        <Routes><Route path="/p/:id/content" element={<><ContentPage /><SettingsRouteMarker /></>} /></Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>);
    await waitFor(() => expect(listBlog).toHaveBeenCalledWith("demo", expect.objectContaining({ filters: { issue: "no_schema" } })));
    const summary = await screen.findByRole("group", { name: "内容摘要" });
    const frame = document.querySelector(".si-page-frame-project.is-table");
    expect(frame?.querySelector(".si-page-frame-header .si-project-header-single")).toBeTruthy();
    expect(frame?.querySelector(".si-page-frame-body .si-content-page .si-tab-panel")).toBeTruthy();
    expect(screen.getByTestId("settings-location").textContent).toBe("/p/demo/content?issue=no_schema");
    fireEvent.click(within(summary).getByRole("button", { name: /无站内链接/ }));
    await waitFor(() => expect(screen.getByTestId("settings-location").textContent).toBe("/p/demo/content?issue=no_links"));
    await waitFor(() => expect(listBlog).toHaveBeenCalledWith("demo", expect.objectContaining({ filters: { issue: "no_links" } })));
  });

  it("常驻按钮在非空博客列表中可用，运行时禁用并在完成后刷新博客数据", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const mockApi = createMockApi();
    const listKeywords = vi.spyOn(mockApi.content, "listKeywords");
    const listBlog = vi.spyOn(mockApi.content, "listBlog");
    const run = vi.fn(async () => ({ runId: "weekly-refresh-1" }));
    mockApi.jobs.run = run;
    mockApi.jobs.history = vi.fn(async () => []);
    let progressHandler: ((progress: JobProgress) => void) | undefined;
    let finishedHandler: ((result: JobResult) => void) | undefined;
    mockApi.jobs.onProgress = (callback) => { progressHandler = callback; return () => { progressHandler = undefined; }; };
    mockApi.jobs.onFinished = (callback) => { finishedHandler = callback; return () => { finishedHandler = undefined; }; };

    vi.doMock("../../api", () => ({
      api: mockApi,
      apiErrorMessage: (_error: unknown, fallback: string) => fallback,
    }));
    const [{ ContentPage }, { ToastProvider }] = await Promise.all([import("../ContentPage"), import("../../components")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/p/demo/content"]}>
            <Routes>
              <Route path="/p/:id/content" element={<ContentPage />} />
              <Route path="/p/:id/settings/config" element={<SettingsRouteMarker />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listKeywords).toHaveBeenCalled());
    const refreshButton = await screen.findByRole("button", { name: "重新抓取博客" });
    const summaryLine = await screen.findByRole("group", { name: "内容摘要" });
    expect(within(summaryLine).getByRole("button", { name: /无站内链接/ })).toBeTruthy();
    expect(within(summaryLine).getByRole("button", { name: /缺少 Schema/ })).toBeTruthy();
    expect(within(summaryLine).getByRole("button", { name: /链接缺货产品/ })).toBeTruthy();
    expect(within(summaryLine).getByRole("button", { name: "数据来源时间" })).toBeTruthy();
    expect(screen.queryByText(/^最近识别：/)).toBeNull();
    expect(screen.queryByRole("button", { name: /关键词映射/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "重新抓取博客" })).toHaveLength(1);
    fireEvent.click(within(summaryLine).getByRole("button", { name: /无站内链接/ }));
    await waitFor(() => expect(listBlog).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ issue: "no_links" }),
    })));
    fireEvent.click(within(summaryLine).getByRole("button", { name: /无站内链接/ }));
    fireEvent.click(refreshButton);
    await waitFor(() => expect(run).toHaveBeenCalledWith({ projectPath: expect.any(String), job: "weekly" }));
    const runningButton = await screen.findByRole("button", { name: "抓取中…" });
    expect((runningButton as HTMLButtonElement).disabled).toBe(true);

    progressHandler?.({ runId: "weekly-refresh-1", projectPath: "D:/Demo", job: "weekly", pct: 50, step: "crawl_pages", level: "info", message: "正在识别博客文章", at: "2026-11-03T00:00:00Z" });
    expect(await screen.findByText("正在识别博客文章")).toBeTruthy();

    finishedHandler?.({ runId: "weekly-refresh-1", job: "weekly", status: "ok", exitCode: 0, summary: "抓取完成" });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["content", "summary", "demo"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["content", "blogs", "demo"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["seo", "summary", "demo"] });
    });
    expect(await screen.findByText("博客内容已重新抓取。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "导出 CSV" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "博客识别设置" }));
    const settingsLocation = await screen.findByTestId("settings-location");
    expect(settingsLocation.textContent).toBe("/p/demo/settings/config?section=blog-recognition");
  }, 25_000);
});

describe("ContentPage DataTable 列契约", () => {
  it.fails("Schema 排序按 has_faq 的真实值改变顺序", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const mockApi = createMockApi();
    const source = await mockApi.content.listBlog("demo", { page: 1, pageSize: 0 });
    const noSchema = { ...source.rows[7]!, url: "https://demo-store.example.test/z-sort-case", slug: "z-sort-case", title: "无 Schema 虚构文章", has_faq: false, published_at: "2026-11-01" };
    const hasSchema = { ...source.rows[0]!, url: "https://demo-store.example.test/a-sort-case", slug: "a-sort-case", title: "有 Schema 虚构文章", has_faq: true, published_at: "2026-11-01" };
    const rows = [noSchema, hasSchema];
    const listBlog = vi.fn(async (_id, query) => {
      const field = query.sort?.field ?? "published_at";
      const sorted = [...rows].sort((left, right) => {
        const a = (left as unknown as Record<string, unknown>)[field];
        const b = (right as unknown as Record<string, unknown>)[field];
        const primary = a == null || b == null ? 0 : String(a).localeCompare(String(b));
        return primary || left.url.localeCompare(right.url);
      });
      const start = (query.page - 1) * query.pageSize;
      return query.pageSize === 0 ? { rows: sorted, total: sorted.length } : { rows: sorted.slice(start, start + query.pageSize), total: sorted.length };
    });
    mockApi.content.listBlog = listBlog;
    vi.doMock("../../api", () => ({ api: mockApi, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ ContentPage }, { ToastProvider }] = await Promise.all([import("../ContentPage"), import("../../components")]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider>
      <MemoryRouter initialEntries={["/p/demo/content"]}><Routes><Route path="/p/:id/content" element={<ContentPage />} /></Routes></MemoryRouter>
    </ToastProvider></QueryClientProvider>);

    const table = await screen.findByRole("region", { name: "content.blog 数据表" });
    fireEvent.click(within(table).getByRole("button", { name: "Schema" }));
    await waitFor(() => expect(listBlog).toHaveBeenCalledWith("demo", expect.objectContaining({ sort: { field: "schema", dir: "asc" } })));
    await waitFor(() => expect(table.querySelector(".si-table tbody tr[data-row-id]")?.textContent).toContain("缺失"));
  });

  it("标题和关键词必显，只有当前结果整列缺值时才标记为空", async () => {
    const mockApi = createMockApi();
    vi.doMock("../../api", () => ({ api: mockApi, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const { blogColumns, keywordColumns } = await import("../ContentPage");
    const blogResult = await mockApi.content.listBlog("demo", { page: 1, pageSize: 50 });
    const keywordResult = await mockApi.content.listKeywords("demo", { page: 1, pageSize: 50 });
    const blog = blogResult.rows[0]!;
    const keyword = keywordResult.rows[0]!;

    const blogDefs = blogColumns([
      { ...blog, word_count: null, primary_keyword: null },
      { ...blog, word_count: 420, primary_keyword: "虚构关键词" },
    ]);
    const emptyBlogDefs = blogColumns([{ ...blog, word_count: null, primary_keyword: null }]);
    const keywordDefs = keywordColumns([
      { ...keyword, target_url: null, search_volume: null, current_rank: null },
      { ...keyword, target_url: "https://demo.example.test/guide", search_volume: 120, current_rank: 8 },
    ]);
    const emptyKeywordDefs = keywordColumns([{ ...keyword, target_url: null, search_volume: null, current_rank: null }]);
    const byId = (columns: readonly { id?: string; enableHiding?: boolean; meta?: { allEmpty?: boolean; align?: string } }[], id: string) => columns.find((column) => column.id === id);

    expect(byId(blogDefs, "title")?.enableHiding).toBe(false);
    expect(byId(keywordDefs, "keyword")?.enableHiding).toBe(false);
    expect(byId(blogDefs, "word_count")?.meta?.allEmpty).toBeUndefined();
    expect(byId(blogDefs, "primary_keyword")?.meta?.allEmpty).toBeUndefined();
    expect(byId(emptyBlogDefs, "word_count")?.meta?.allEmpty).toBe(true);
    expect(byId(emptyBlogDefs, "primary_keyword")?.meta?.allEmpty).toBe(true);
    expect(byId(keywordDefs, "target_url")?.meta?.allEmpty).toBeUndefined();
    expect(byId(emptyKeywordDefs, "target_url")?.meta?.allEmpty).toBe(true);
    expect(byId(emptyKeywordDefs, "search_volume")?.meta?.allEmpty).toBe(true);
    expect(byId(emptyKeywordDefs, "current_rank")?.meta?.allEmpty).toBe(true);
    expect(byId(blogDefs, "links_products")?.meta?.align).toBe("end");
  });
});
