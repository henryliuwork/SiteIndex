// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RunLog } from "@siteindex/shared";
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
  vi.unstubAllGlobals();
  vi.doUnmock("../api");
  vi.resetModules();
});

async function renderRunsPage(history: RunLog[]) {
  const mockApi = createMockApi();
  const project = await mockApi.projects.get("demo");
  mockApi.projects.get = vi.fn(async (id) => ({ ...project, summary: { ...project.summary, id } }));
  mockApi.jobs.history = vi.fn(async () => history);
  mockApi.jobs.running = vi.fn(async () => null);
  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  }));
  const [{ RunsPage }, { ToastProvider }] = await Promise.all([import("./RunsPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  render(<ToastProvider><QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={["/p/demo/runs"]}><Routes><Route path="/p/:id/runs" element={<RunsPage />} /></Routes></MemoryRouter>
  </QueryClientProvider></ToastProvider>);
  return { mockApi };
}

async function renderRunsPageWithRecentLog() {
  const mockApi = createMockApi();
  const project = await mockApi.projects.get("demo");
  mockApi.projects.get = vi.fn(async (id) => ({ ...project, summary: { ...project.summary, id } }));
  mockApi.jobs.running = vi.fn(async () => ({ runId: "demo-active-run", job: "daily" }));
  mockApi.jobs.onProgress = vi.fn((callback) => {
    queueMicrotask(() => callback({
      runId: "demo-active-run", projectPath: project.summary.path, job: "daily", pct: 25,
      step: "fetch_feed", level: "info", message: "正在读取演示 Feed", at: "2026-11-17T00:00:00.000Z",
    }));
    return () => {};
  });
  vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
  const [{ RunsPage }, { ToastProvider }] = await Promise.all([import("./RunsPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  render(<ToastProvider><QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={["/p/demo/runs"]}><Routes><Route path="/p/:id/runs" element={<RunsPage />} /></Routes></MemoryRouter>
  </QueryClientProvider></ToastProvider>);
}

describe("RunsPage 媒体任务历史", () => {
  it("近期日志使用浅色卡片可读文字，深色控制台保留原有配色", async () => {
    await renderRunsPageWithRecentLog();
    await waitFor(() => expect(document.querySelector(".si-run-recent-log .si-run-log-info span")?.textContent).toBe("正在读取演示 Feed"));

    const workspaceCssPath = resolve(process.cwd(), "packages/ui/src/pages/runs/page.css");
    const css = readFileSync(existsSync(workspaceCssPath) ? workspaceCssPath : resolve(process.cwd(), "src/pages/runs/page.css"), "utf8");
    expect(css).toMatch(/\.si-run-log span\s*\{\s*color:\s*var\(--color-surface\)/);
    expect(css).toMatch(/\.si-run-recent-log \.si-run-log span\s*\{\s*color:\s*var\(--color-ink-2\)/);
    expect(css).toMatch(/\.si-run-recent-log \.si-run-log small\s*\{\s*color:\s*var\(--color-muted\)/);
    expect(css).toMatch(/\.si-run-recent-log \.si-run-log-warn span\s*\{\s*color:\s*var\(--color-warn\)/);
    expect(css).toMatch(/\.si-run-recent-log \.si-run-log-error span\s*\{\s*color:\s*var\(--color-danger\)/);
  });

  it("从页头选择任务运行，概览卡片只展示状态", async () => {
    const { mockApi } = await renderRunsPage([]);
    const runJob = vi.spyOn(mockApi.jobs, "run");
    fireEvent.click(await screen.findByRole("button", { name: "立即运行" }));
    fireEvent.click(await screen.findByRole("button", { name: "每日同步" }));
    await waitFor(() => expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ job: "daily" })));
    expect(document.querySelector(".si-run-job-card")?.tagName).toBe("DIV");
  });

  it("任务卡片与展开详情不重复显示历史列表的开始时间", async () => {
    await renderRunsPage([{
      run_id: "demo-daily-history",
      job: "daily",
      started_at: "2025-01-02T03:04:00.000Z",
      finished_at: "2025-01-02T03:05:00.000Z",
      status: "ok",
    }]);

    expect(await screen.findByText("上次运行：成功")).toBeTruthy();
    const historyEntry = document.querySelector<HTMLElement>(".si-run-history-item")!;
    const started = historyEntry.querySelector(".si-run-history-time")?.textContent;
    expect(started).toBeTruthy();
    expect(document.querySelector(".si-runs-page")?.textContent?.split(started!)).toHaveLength(2);
    expect(within(historyEntry).queryByText(/^开始：/)).toBeNull();
  });

  it("用逐 SKU 持久化结果生成媒体历史摘要", async () => {
    await renderRunsPage([{
      run_id: "demo-media-history",
      job: "media",
      started_at: "2026-11-12T06:00:00.000Z",
      finished_at: "2026-11-12T06:01:00.000Z",
      status: "partial",
      media_requested_skus: ["DEMO-RUN-001", "DEMO-RUN-002", "DEMO-RUN-003"],
      media_batch_state: "outcome_unknown",
      media_results: [{ sku: "DEMO-RUN-001", status: "recorded" }],
      media_unknown_skus: ["DEMO-RUN-002"],
      media_not_started_skus: ["DEMO-RUN-003"],
    }]);

    const mediaJob = await screen.findByText("图片 URL 处理", { exact: true });
    const historyEntry = mediaJob.closest("details");
    expect(historyEntry).toBeTruthy();
    expect(within(historyEntry!).getByText("记录原图 URL 1 · 结果未知 1 · 已确认未开始 1")).toBeTruthy();
  });
});
