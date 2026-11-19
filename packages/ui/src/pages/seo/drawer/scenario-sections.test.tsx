// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScenarioQueryResult, SeoPageBrief } from "@siteindex/shared";
import { createMockApi } from "../../../mock";

vi.setConfig({ testTimeout: 15_000 });
afterEach(() => { cleanup(); vi.doUnmock("../../../api"); vi.doUnmock("@siteindex/shared"); vi.resetModules(); });

async function renderSections(options: {
  mock?: boolean;
  pending?: string[];
  pageBrief?: (id: string, url: string) => Promise<ScenarioQueryResult<SeoPageBrief>>;
} = {}) {
  const mockApi = createMockApi();
  const pages = await mockApi.seo.listPages("demo", { page: 1, pageSize: 1 });
  const url = pages.rows[0]!.url;
  if (options.pageBrief) mockApi.seo.pageBrief = options.pageBrief;
  vi.doMock("../../../api", () => ({ api: mockApi, isMockApi: options.mock ?? true, apiErrorDetails: () => null }));
  if (options.pending) vi.doMock("@siteindex/shared", async (original) => {
    const actual = await original<typeof import("@siteindex/shared")>();
    return { ...actual, PENDING_HANDLERS: options.pending };
  });
  const { SeoScenarioSections, seoScenarioTabs } = await import("./scenario-sections");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><SeoScenarioSections id="demo" url={url} overview={<div>原页面概况</div>} /></QueryClientProvider>);
  return { mockApi, url, seoScenarioTabs };
}

describe("SEO 行抽屉只读场景", () => {
  it("接口缺失或仍待接线时整体隐藏对应入口", async () => {
    const { mockApi, seoScenarioTabs } = await renderSections({ mock: false, pending: ["seo.pageBrief", "seo.issueCandidates", "seo.internalLinkContext"] });
    expect(screen.getByText("原页面概况")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "页面详情分段" })).toBeNull();
    expect(seoScenarioTabs(mockApi.seo, false, ["seo.pageBrief", "seo.issueCandidates", "seo.internalLinkContext"])).toEqual(["overview"]);
    delete mockApi.seo.pageBrief;
    expect(seoScenarioTabs(mockApi.seo, false, [])).not.toContain("brief");
  });

  it("页面简报调用只读 IPC 并显示数据", async () => {
    const { mockApi, url } = await renderSections();
    const pageBrief = vi.spyOn(mockApi.seo, "pageBrief");
    fireEvent.click(screen.getByRole("button", { name: "页面简报" }));
    await waitFor(() => expect(pageBrief).toHaveBeenCalledWith("demo", url));
    expect(await screen.findByText("相关问题")).toBeTruthy();
  });

  it("加载、空数据、错误和重试均有明确反馈", async () => {
    let finish!: (value: ScenarioQueryResult<SeoPageBrief>) => void;
    const deferred = new Promise<ScenarioQueryResult<SeoPageBrief>>((resolve) => { finish = resolve; });
    const { mockApi, url } = await renderSections({ pageBrief: vi.fn(() => deferred) });
    fireEvent.click(screen.getByRole("button", { name: "页面简报" }));
    expect(screen.getByRole("status").textContent).toContain("正在加载");
    const page = await mockApi.seo.getPage("demo", url);
    finish({ data: null, metadata: { sources: [], collected_at: null, missing_fields: [], quality: "partial", anomalies: [] } });
    expect(await screen.findByText("没有这张页面的简报。")).toBeTruthy();
    expect(page).toBeTruthy();
  });

  it("查询失败显示可重试的 ApiErrorNotice", async () => {
    const pageBrief = vi.fn().mockRejectedValueOnce(new Error("演示查询失败"));
    await renderSections({ pageBrief });
    fireEvent.click(screen.getByRole("button", { name: "页面简报" }));
    expect(await screen.findByText("查询失败。")).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });
});
