// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AttentionItem, JobResult } from "@siteindex/shared";
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function renderOverview(mockApi: ReturnType<typeof createMockApi>) {
  vi.doMock("../api", () => ({
    api: mockApi,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  const [{ OverviewPage }, { ToastProvider }] = await Promise.all([import("./OverviewPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><OverviewPage /></MemoryRouter></QueryClientProvider></ToastProvider>);
  return queryClient;
}

describe("OverviewPage 布局和操作", () => {
  it("按 KPI、关注、README 摘要、变更记录排列，并把快捷操作放进页面操作区", async () => {
    await renderOverview(createMockApi());

    expect(await screen.findByRole("heading", { name: "需要关注" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "快捷操作" })).toBeNull();
    expect(screen.getByRole("button", { name: "立即同步" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开项目文件夹" })).toBeTruthy();

    const content = document.querySelector(".si-overview-content");
    expect([...content!.children].map((element) => element.classList[0] || element.tagName.toLowerCase())).toEqual([
      "si-overview-kpis", "si-overview-attention", "si-overview-readme", "si-overview-changelog",
    ]);
    expect(document.querySelector(".si-overview-content > .si-page-header")).toBeNull();
    expect(document.querySelector<HTMLDetailsElement>(".si-overview-instruction")?.open).toBe(false);
    expect(document.querySelector(".si-overview-instruction")?.textContent).toContain("Agent 接入指令");

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "校验本地数据文件" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "复制 agent 接入指令" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "打开 README" })).toBeTruthy();
  }, 10_000);

  it("项目同步状态使用具体月日与时间，不使用‘今天’", async () => {
    const mockApi = createMockApi();
    const project = await mockApi.projects.get("demo");
    mockApi.projects.get = vi.fn(async () => ({
      ...project,
      summary: { ...project.summary, sync: { ...project.summary.sync, state: "ok" as const, at: new Date(2026, 10, 8, 17, 0).toISOString() } },
    }));
    await renderOverview(mockApi);

    expect(await screen.findByText(/11-08 17:00 · 同步成功/)).toBeTruthy();
    expect(screen.queryByText(/今天/)).toBeNull();
  });

  it("关注、README 与变更记录没有内容时都显示紧凑空状态", async () => {
    const mockApi = createMockApi();
    const overview = await mockApi.overview.get("demo");
    mockApi.overview.get = vi.fn(async () => ({
      ...overview,
      attention: [],
      readme: { ...overview.readme, overview: "", focus: "" },
      changelog: [],
    }));
    await renderOverview(mockApi);

    expect(await screen.findByText("当前没有需要处理的事项。")).toBeTruthy();
    expect(screen.getByText("暂无 README 项目概况。").classList.contains("si-overview-readme-empty")).toBe(true);
    expect(screen.getByText("暂无变更记录。")).toBeTruthy();
    expect(screen.queryByText("当前重点")).toBeNull();
  });

  it("把快捷操作结果显示为 Toast", async () => {
    const mockApi = createMockApi();
    const overview = await mockApi.overview.get("demo");
    mockApi.overview.get = vi.fn(async () => ({ ...overview, agent_instruction: "Use the demo project index." }));
    mockApi.shell.copyText = vi.fn(async () => undefined);
    await renderOverview(mockApi);

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制 agent 接入指令" }));

    expect(mockApi.shell.copyText).toHaveBeenCalledOnce();
    expect(await screen.findByText("已复制 agent 接入指令。")).toBeTruthy();
  });

  it("同步期间显示 Notice，完成后刷新项目和概览缓存并显示 Toast", async () => {
    const mockApi = createMockApi();
    mockApi.jobs.run = vi.fn(async () => ({ runId: "run-1" }));
    let finish: ((result: JobResult) => void) | undefined;
    mockApi.jobs.onFinished = vi.fn((callback) => {
      finish = callback;
      return () => undefined;
    });
    const queryClient = await renderOverview(mockApi);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const syncButton = await screen.findByRole("button", { name: "立即同步" });

    fireEvent.click(syncButton);

    expect(await screen.findByText("正在启动每日同步…")).toBeTruthy();
    expect(syncButton.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    finish?.({ runId: "run-1", job: "daily", status: "ok", exitCode: 0, summary: "每日同步已完成" });

    expect(await screen.findByText("每日同步已完成。")).toBeTruthy();
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["overview", "demo"] })));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects", "demo"], exact: true }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects"], exact: true }));
  });
});

describe("OverviewPage SEO 规则忽略", () => {
  it("忽略按钮只在存在规则和可选 IPC 方法时显示", async () => {
    const mockApi = createMockApi();
    const summary = await mockApi.overview.get("demo");
    const attention: AttentionItem[] = [{ severity: "mid", text: "尚未填写 GMC feed", link: "/p/demo/settings", link_label: "配置 feed" }];
    mockApi.overview.get = vi.fn(async () => ({ ...summary, attention }));
    mockApi.seo.setRuleIgnored = vi.fn(async () => ({ updated: 1 }));
    await renderOverview(mockApi);

    expect(await screen.findByText("尚未填写 GMC feed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "忽略" })).toBeNull();
  });

  it("Core 返回页面 URL 时可从 SEO 提醒文案识别规则", async () => {
    const mockApi = createMockApi();
    const summary = await mockApi.overview.get("demo");
    const attention: AttentionItem[] = [{
      severity: "mid", text: "Meta description 缺失：2 个页面",
      link: "https://demo-store.example.test/catalog/item-a", link_label: "查看问题",
    }];
    mockApi.overview.get = vi.fn(async () => ({ ...summary, attention }));
    mockApi.seo.setRuleIgnored = vi.fn(async () => ({ updated: 2 }));
    await renderOverview(mockApi);

    expect(await screen.findByRole("button", { name: "忽略" })).toBeTruthy();
  });

  it("按概览问题规则确认全站影响并刷新计数", async () => {
    const mockApi = createMockApi();
    const summary = await mockApi.overview.get("demo");
    const attention: AttentionItem[] = [{
      severity: "mid", text: "Meta description 缺失：2 个页面",
      link: "/p/demo/seo?rule=desc_missing&status=open", link_label: "查看 SEO 问题",
    }];
    mockApi.overview.get = vi.fn(async () => ({ ...summary, attention }));
    const setRuleIgnored = vi.fn(async () => ({ updated: 2 }));
    mockApi.seo.setRuleIgnored = setRuleIgnored;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const queryClient = await renderOverview(mockApi);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(await screen.findByRole("button", { name: "忽略" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：全站同一规则"));
    await waitFor(() => expect(setRuleIgnored).toHaveBeenCalledWith("demo", "desc_missing", true));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["overview", "demo"] })));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "summary", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "issues", "demo"] }));
    expect(await screen.findByText("已更新 2 条")).toBeTruthy();
  });
});
