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

async function renderRunsPage(history: RunLog[], initialPath = "/p/demo/runs") {
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
    <MemoryRouter initialEntries={[initialPath]}><Routes><Route path="/p/:id/runs" element={<RunsPage />} /></Routes></MemoryRouter>
  </QueryClientProvider></ToastProvider>);
  return { mockApi };
}

async function renderRunsPageWithLogState(status: "running" | "ok" | "failed") {
  const mockApi = createMockApi();
  const project = await mockApi.projects.get("demo");
  mockApi.projects.get = vi.fn(async (id) => ({ ...project, summary: { ...project.summary, id } }));
  mockApi.jobs.running = vi.fn(async () => ({ runId: "demo-active-run", job: "daily" }));
  mockApi.jobs.onProgress = vi.fn((callback) => {
    queueMicrotask(() => {
      for (const [level, message] of [["info", "读取演示 Feed"], ["warn", "跳过演示记录"], ["error", "演示步骤失败"]] as const) {
        callback({ runId: "demo-active-run", projectPath: project.summary.path, job: "daily", pct: 25,
          step: "fetch_feed", level, message, at: "2026-11-17T00:00:00.000Z" });
      }
    });
    return () => {};
  });
  mockApi.jobs.onFinished = vi.fn((callback) => {
    if (status !== "running") queueMicrotask(() => callback({ runId: "demo-active-run", job: "daily", status, exitCode: status === "ok" ? 0 : 1, summary: status === "ok" ? "演示任务完成" : "演示任务失败" }));
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
  it("为每日计划行和计划任务状态提供稳定验收选择器", async () => {
    await renderRunsPage([]);

    const dailyScheduleRow = await screen.findByTestId("runs-schedule-row-daily");
    expect(dailyScheduleRow.tagName).toBe("ARTICLE");
    expect(dailyScheduleRow.classList.contains("si-schedule-row")).toBe(true);
    expect(await screen.findByTestId("runs-schedule-plan-status")).toBeTruthy();
  });

  it.each(["running", "ok", "failed"] as const)("%s 状态在深色控制台展示 info、warn、error 日志", async (status) => {
    await renderRunsPageWithLogState(status);
    const console = await screen.findByRole("log", { name: "运行日志" });
    expect(console.closest(".si-run-console")).toBeTruthy();
    await waitFor(() => expect(console.querySelectorAll(".si-run-log")).toHaveLength(3));
    const { formatDateTime } = await import("../components");
    expect(console.querySelector(".si-run-log code")?.textContent).toBe(formatDateTime("2026-11-17T00:00:00.000Z"));
    for (const level of ["info", "warn", "error"]) expect(console.querySelector(`.si-run-log-${level} span`)?.textContent).toBeTruthy();
    if (status === "running") {
      expect(screen.getByRole("progressbar", { name: "任务进度" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    } else {
      await waitFor(() => expect(document.querySelector(".si-run-state")?.textContent).toContain(status === "ok" ? "成功" : "失败"));
    }
  }, 15000);

  it("深色日志的三级文字使用足够对比度的语义 token", () => {
    const workspaceCssPath = resolve(process.cwd(), "packages/ui/src/pages/runs/page.css");
    const css = readFileSync(existsSync(workspaceCssPath) ? workspaceCssPath : resolve(process.cwd(), "src/pages/runs/page.css"), "utf8");
    const workspaceTokensPath = resolve(process.cwd(), "packages/ui/src/styles/tokens.css");
    const tokens = readFileSync(existsSync(workspaceTokensPath) ? workspaceTokensPath : resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
    const token = (name: string) => {
      const match = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
      if (!match) throw new Error(`缺少颜色 token：${name}`);
      return match[1]!;
    };
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255);
      const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
    };
    const background = luminance(token("--color-ink"));
    for (const name of ["--color-surface", "--color-line-strong", "--color-stock-preorder", "--color-danger-soft"]) {
      const foreground = luminance(token(name));
      expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toMatch(/\.si-run-console\s*\{[^}]*background:\s*var\(--color-ink\)/);
    expect(css).toMatch(/\.si-run-log code\s*\{\s*color:\s*var\(--color-line-strong\)/);
    expect(css).toMatch(/\.si-run-log span\s*\{\s*color:\s*var\(--color-surface\)/);
    expect(css).toMatch(/\.si-run-log small\s*\{\s*color:\s*var\(--color-line-strong\)/);
    expect(css).toMatch(/\.si-run-log-warn span\s*\{\s*color:\s*var\(--color-stock-preorder\)/);
    expect(css).toMatch(/\.si-run-log-error span\s*\{\s*color:\s*var\(--color-danger-soft\)/);
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

  it("无明细的跳过任务不误报执行设备不匹配", async () => {
    await renderRunsPage([{
      run_id: "demo-skipped-run", job: "daily", started_at: "2026-11-20T08:00:00+08:00",
      finished_at: "2026-11-20T08:00:01+08:00", status: "skipped",
    }]);
    const historyEntry = await screen.findByText("任务已跳过");
    expect(historyEntry.closest(".si-run-history-item")).toBeTruthy();
    expect(screen.queryByText("未在指定执行设备运行")).toBeNull();
  });

  it("从概览失败任务链接进入时展开对应运行日志", async () => {
    await renderRunsPage([{
      run_id: "demo-failed-run", job: "weekly", started_at: "2026-11-20T08:00:00+08:00",
      finished_at: "2026-11-20T08:01:03+08:00", status: "failed", errors: ["演示抓取失败"],
    }], "/p/demo/runs?run=demo-failed-run");
    await screen.findByText("运行历史");
    await waitFor(() => expect(document.querySelector<HTMLDetailsElement>(".si-run-history-item")?.open).toBe(true));
    expect(screen.getAllByText("演示抓取失败").length).toBeGreaterThan(0);
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
