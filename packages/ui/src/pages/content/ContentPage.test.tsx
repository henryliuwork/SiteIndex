// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { JobProgress, JobResult } from "@siteindex/shared";
import { createMockApi } from "../../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../../api");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("ContentPage 博客重新抓取", () => {
  it("常驻按钮在非空博客列表中可用，运行时禁用并在完成后刷新博客数据", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const mockApi = createMockApi();
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
    const { ContentPage } = await import("../ContentPage");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/demo/content"]}>
          <Routes><Route path="/p/:id/content" element={<ContentPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const refreshButton = await screen.findByRole("button", { name: "重新抓取" });
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
    });
  }, 25_000);
});
