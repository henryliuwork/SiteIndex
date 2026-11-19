// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScenarioQueryResult, SeoPageBrief, SeoIssue } from "@siteindex/shared";
import { createMockApi } from "../../../mock";

vi.setConfig({ testTimeout: 15_000 });
afterEach(() => { cleanup(); vi.doUnmock("../../../api"); vi.doUnmock("@siteindex/shared"); vi.resetModules(); });

async function renderSections(options: {
  mock?: boolean;
  pending?: string[];
  pageBrief?: (id: string, url: string) => Promise<ScenarioQueryResult<SeoPageBrief>>;
  issueActions?: { markFixed?: (issue: SeoIssue) => void };
  omitCandidates?: boolean;
} = {}) {
  const mockApi = createMockApi();
  const pages = await mockApi.seo.listPages("demo", { page: 1, pageSize: 1 });
  const url = pages.rows[0]!.url;
  if (options.pageBrief) mockApi.seo.pageBrief = options.pageBrief;
  if (options.omitCandidates) delete mockApi.seo.issueCandidates;
  vi.doMock("../../../api", () => ({ api: mockApi, isMockApi: options.mock ?? true, apiErrorDetails: () => null }));
  if (options.pending) vi.doMock("@siteindex/shared", async (original) => {
    const actual = await original<typeof import("@siteindex/shared")>();
    return { ...actual, PENDING_HANDLERS: options.pending };
  });
  const { SeoScenarioSections, seoScenarioTabs } = await import("./scenario-sections");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><SeoScenarioSections id="demo" url={url} overview={<div>原页面概况</div>} issueActions={options.issueActions} /></QueryClientProvider>);
  return { mockApi, url, seoScenarioTabs };
}

describe("SEO 行抽屉只读场景", () => {
  it("接口缺失或仍待接线时整体隐藏对应入口", async () => {
    const { mockApi, seoScenarioTabs } = await renderSections({ mock: false, pending: ["seo.pageBrief", "seo.issueCandidates", "seo.internalLinkContext"] });
    expect(screen.getByText("原页面概况")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "页面详情分段" })).toBeNull();
    expect(seoScenarioTabs(mockApi.seo, false, ["seo.pageBrief", "seo.issueCandidates", "seo.internalLinkContext"])).toEqual(["index"]);
    delete mockApi.seo.pageBrief;
    expect(seoScenarioTabs(mockApi.seo, false, [])).toContain("issues");
    delete mockApi.seo.issueCandidates;
    expect(seoScenarioTabs(mockApi.seo, false, [])).not.toContain("issues");
  });

  it("问题分段调用页面简报 IPC 并显示该页问题", async () => {
    const { mockApi, url } = await renderSections();
    const pageBrief = vi.spyOn(mockApi.seo, "pageBrief");
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    await waitFor(() => expect(pageBrief).toHaveBeenCalledWith("demo", url));
    expect(await screen.findByText(/SEO 问题|缺少/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "内链" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收录" })).toBeTruthy();
  });

  it("问题操作只调用传入处理器，缺少方法时不出现按钮", async () => {
    const markFixed = vi.fn();
    await renderSections({ issueActions: { markFixed } });
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    const buttons = await screen.findAllByRole("button", { name: "标记已处理" });
    fireEvent.click(buttons[0]!);
    expect(markFixed).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "忽略此页面此问题" })).toBeNull();
  });

  it("同一问题分段保留只读问题候选查询", async () => {
    const { mockApi, url } = await renderSections();
    const candidates = vi.spyOn(mockApi.seo, "issueCandidates");
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    expect(candidates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "待处理问题候选" }));
    await waitFor(() => expect(candidates).toHaveBeenCalledWith("demo", url));
  });

  it("问题候选接口缺失时隐藏入口", async () => {
    await renderSections({ omitCandidates: true });
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    expect(screen.queryByRole("button", { name: "待处理问题候选" })).toBeNull();
  });

  it("加载、空数据、错误和重试均有明确反馈", async () => {
    let finish!: (value: ScenarioQueryResult<SeoPageBrief>) => void;
    const deferred = new Promise<ScenarioQueryResult<SeoPageBrief>>((resolve) => { finish = resolve; });
    const { mockApi, url } = await renderSections({ pageBrief: vi.fn(() => deferred) });
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    expect(screen.getByRole("status").textContent).toContain("正在加载");
    const page = await mockApi.seo.getPage("demo", url);
    finish({ data: null, metadata: { sources: [], collected_at: null, missing_fields: [], quality: "partial", anomalies: [] } });
    expect(await screen.findByText("没有这张页面的问题数据。")).toBeTruthy();
    expect(page).toBeTruthy();
  });

  it("查询失败显示可重试的 ApiErrorNotice", async () => {
    const pageBrief = vi.fn().mockRejectedValueOnce(new Error("演示查询失败"));
    await renderSections({ pageBrief });
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    expect(await screen.findByText("查询失败。")).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });
});
