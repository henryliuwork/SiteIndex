// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RunLog } from "@siteindex/shared";
import { createMockApi } from "../mock";

afterEach(() => {
  cleanup();
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

describe("RunsPage 媒体任务历史", () => {
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
