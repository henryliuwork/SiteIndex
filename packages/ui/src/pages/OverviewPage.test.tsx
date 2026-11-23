// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AttentionItem, JobResult } from "@siteindex/shared";
import { createMockApi } from "../mock";
import { recentBlogCount } from "./overview/secondary-modules";
import type { BlogPost } from "@siteindex/shared";

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
    apiErrorDetails: (error: unknown) => error instanceof Error ? { message: error.message } : null,
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
  it("无 Feed 自动采集已配置时不显示阻断提示或常驻横幅", async () => {
    const mockApi = createMockApi();
    const project = await mockApi.projects.get("demo");
    const overview = await mockApi.overview.get("demo");
    mockApi.projects.get = vi.fn(async () => ({
      ...project,
      config: { ...project.config, crawl: { ...project.config.crawl, feed_url: "", auto_collect_products: true } },
    }));
    mockApi.overview.get = vi.fn(async () => ({ ...overview, attention: [
      { severity: "mid" as const, text: "尚未填写 GMC feed", link: "/p/demo/settings", link_label: "配置 feed" },
      ...overview.attention,
    ] }));
    await renderOverview(mockApi);
    expect(await screen.findByRole("region", { name: "SEO" })).toBeTruthy();
    expect(screen.queryByText("无 Feed 自动采集已启用")).toBeNull();
    expect(screen.queryByText("尚未填写 GMC feed")).toBeNull();
    expect(screen.queryByText(/未配置商品来源|每日库存同步未启用/)).toBeNull();
  });

  it("待办、产品管理、SEO 模块使用真实查询计数并链接到对应筛选", async () => {
    const mockApi = createMockApi();
    const inventory = await mockApi.inventory.summary("demo");
    mockApi.inventory.summary = vi.fn(async () => ({ ...inventory, product_management: {
      as_of: "2026-11-13", total_rows: 20, in_stock_rows: 15, online_rate: 0.75,
      changed_rows: 2, out_of_stock_7d_rows: 3, fluctuating_30d_rows: 1,
    } }));
    const seo = await mockApi.seo.summary("demo");
    mockApi.seo.summary = vi.fn(async () => ({ ...seo, crawled_at: "2026-11-13T08:00:00.000Z",
      kpis: seo.kpis.map((item) => item.key === "issues" ? { ...item, value: "2" } : item) }));
    const originalSeoRows = mockApi.seo.listPageRows!;
    mockApi.seo.listPageRows = vi.fn(async (id, query) => ({ ...await originalSeoRows(id, query),
      summary: { latest_crawl_date: "2026-11-13", open_pages: 9, new_pages: 4, unindexed_pages: 3, fixed_pages: 2 } }));
    await renderOverview(mockApi);

    await waitFor(() => expect(screen.getByRole("region", { name: "产品管理" }).textContent).toContain("75%"));
    const modules = document.querySelectorAll(".si-overview-module");
    expect([...modules].map((module) => module.getAttribute("aria-label"))).toEqual(["待办", "产品管理", "SEO", "内容", "网站主色", "最近抓取任务记录"]);
    await waitFor(() => expect(document.querySelectorAll(".si-overview-module-metric[href]").length).toBeGreaterThanOrEqual(8));
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".si-overview-module-metric[href]")].slice(0, 8);
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["未完成3", "/p/demo/todos?status=active"],
      ["在线率75%", "/p/demo/products?summary_metric=in_stock"],
      ["今日变化2", "/p/demo/products?summary_metric=changed"],
      ["长期缺货3", "/p/demo/products?summary_metric=out_of_stock_7d"],
      ["状态波动1", "/p/demo/products?summary_metric=fluctuating_30d"],
      ["待处理问题2", "/p/demo/seo?status=open"],
      ["本次新增问题页4", "/p/demo/seo?summary=new"],
      ["未收录页面3", "/p/demo/seo?summary=unindexed"],
    ]);
    expect(screen.getByText("本周到期").nextElementSibling?.textContent).toBe("—");
    expect(screen.getByText("待办尚无截止时间数据。")).toBeTruthy();
    expect(mockApi.seo.listPageRows).toHaveBeenCalledWith("demo", { page: 1, pageSize: 1, filters: {} });
    expect(mockApi.inventory.summary).toHaveBeenCalledWith("demo", 30);
  });

  it("旧 bridge 缺少 SEO 页面聚合时不造 0，并明确说明", async () => {
    const mockApi = createMockApi();
    delete mockApi.seo.listPageRows;
    await renderOverview(mockApi);
    expect(await screen.findByText("当前版本尚未提供 SEO 页面聚合。")).toBeTruthy();
    expect(screen.getByText("本次新增问题页").nextElementSibling?.textContent).toBe("—");
    expect(screen.getByRole("region", { name: "SEO" }).textContent).toContain("待处理问题");
  });

  it("内容卡只统计真实发表日期，核心词覆盖按项目配置计算", async () => {
    const mockApi = createMockApi();
    const project = await mockApi.projects.get("demo");
    mockApi.projects.get = vi.fn(async () => ({ ...project, config: { ...project.config,
      seo: { ...project.config.seo, core_keywords: ["demo guide", "demo category"] } } }));
    const content = await mockApi.content.summary("demo");
    mockApi.content.summary = vi.fn(async () => ({ ...content, uncovered_core_keywords: ["demo guide"] }));
    const blogs = await mockApi.content.listBlog("demo", { page: 1, pageSize: 1, filters: {} });
    mockApi.content.listBlog = vi.fn(async () => ({ rows: [
      { ...blogs.rows[0]!, published_at: new Date().toLocaleDateString("en-CA") },
      { ...blogs.rows[0]!, url: "https://demo.example.test/old", published_at: "2026-01-01" },
    ], total: 2 }));
    await renderOverview(mockApi);
    await waitFor(() => expect(screen.getByRole("region", { name: "内容" }).textContent).toContain("核心词覆盖1/2"));
    expect(screen.getByRole("region", { name: "内容" }).textContent).toContain("博客文章2");
    expect(screen.getByRole("region", { name: "内容" }).textContent).toContain("近 7 天新增1");
    expect(mockApi.content.listBlog).toHaveBeenCalledWith("demo", { page: 1, pageSize: 0, filters: {} });
  });

  it("网站主色可复制真实 HEX，最近失败任务可直达日志", async () => {
    const mockApi = createMockApi();
    mockApi.shell.copyText = vi.fn(async () => undefined);
    mockApi.jobs.history = vi.fn(async () => [{ run_id: "demo-failed-run", job: "weekly" as const, status: "failed" as const,
      started_at: "2026-11-20T08:00:00+08:00", finished_at: "2026-11-20T08:01:03+08:00" }]);
    await renderOverview(mockApi);
    const copy = await screen.findByRole("button", { name: /复制主色 #/ });
    fireEvent.click(copy);
    await waitFor(() => expect(mockApi.shell.copyText).toHaveBeenCalledWith(expect.stringMatching(/^#[0-9A-F]{6}$/)));
    const job = screen.getByRole("region", { name: "最近抓取任务记录" });
    expect(job.querySelector(".is-failed a")?.getAttribute("href")).toBe("/p/demo/runs?run=demo-failed-run");
    expect(job.textContent).toContain("1 分 3 秒");
    expect(mockApi.jobs.history).toHaveBeenCalledWith("demo", 5);
  });

  it("最近五条任务可展开查看，首屏只显示最新任务时间", async () => {
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => Array.from({ length: 5 }, (_, index) => ({
      run_id: `demo-run-${index}`, job: "daily" as const, status: "ok" as const,
      started_at: `2026-11-${String(20 - index).padStart(2, "0")}T08:00:00+08:00`,
      finished_at: `2026-11-${String(20 - index).padStart(2, "0")}T08:01:00+08:00`,
    })));
    await renderOverview(mockApi);
    const jobs = await screen.findByRole("region", { name: "最近抓取任务记录" });
    await waitFor(() => expect(jobs.querySelectorAll(".si-overview-jobs a")).toHaveLength(1));
    const toggle = screen.getByRole("button", { name: "查看其余 4 条" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(jobs.querySelectorAll(".si-overview-jobs a")).toHaveLength(5);
    expect(jobs.querySelectorAll(".si-overview-jobs time")).toHaveLength(5);
  });

  it("配色查询失败只影响配色卡，支持单卡重试", async () => {
    const mockApi = createMockApi();
    mockApi.design.get = vi.fn(async () => { throw new Error("演示设计数据暂不可用"); });
    await renderOverview(mockApi);
    expect(await screen.findByText("网站配色加载失败。")).toBeTruthy();
    expect(screen.getByRole("region", { name: "内容" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "最近抓取任务记录" })).toBeTruthy();
    fireEvent.click(screen.getByRole("region", { name: "网站主色" }).querySelector("button")!);
    await waitFor(() => expect(mockApi.design.get).toHaveBeenCalledTimes(2));
  });

  it("待办加载失败不遮挡产品与 SEO，且可单独重试", async () => {
    const mockApi = createMockApi();
    mockApi.todos!.list = vi.fn(async () => { throw new Error("待办读取失败"); });
    await renderOverview(mockApi);
    expect(await screen.findByText("待办加载失败。")).toBeTruthy();
    expect(screen.getByRole("region", { name: "产品管理" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "SEO" })).toBeTruthy();
    fireEvent.click(screen.getByRole("region", { name: "待办" }).querySelector("button")!);
    await waitFor(() => expect(mockApi.todos!.list).toHaveBeenCalledTimes(2));
  });

  it("无业务日和无完整规则检查时显示空态，不把缺失值写成 0", async () => {
    const mockApi = createMockApi();
    const inventory = await mockApi.inventory.summary("demo");
    mockApi.inventory.summary = vi.fn(async () => ({ ...inventory, product_management: { ...inventory.product_management!, as_of: null } }));
    mockApi.todos!.list = vi.fn(async () => ({ items: [], scan: { status: "not_run" as const, evaluated_at: null } }));
    const seo = await mockApi.seo.summary("demo");
    mockApi.seo.summary = vi.fn(async () => ({ ...seo, crawled_at: null }));
    const listPageRows = mockApi.seo.listPageRows!;
    mockApi.seo.listPageRows = vi.fn(async (id, query) => ({ ...await listPageRows(id, query),
      summary: { latest_crawl_date: null, open_pages: 0, new_pages: 0, unindexed_pages: 0, fixed_pages: 0 } }));
    await renderOverview(mockApi);
    expect(await screen.findByText("规则检查尚未完整完成，暂不能确认未完成数。")).toBeTruthy();
    expect(screen.getByText("尚无产品管理业务日数据，请先同步商品。")).toBeTruthy();
    expect(await screen.findByText("尚无 SEO 抓取数据，请先运行抓取。")).toBeTruthy();
    expect(screen.getByRole("region", { name: "产品管理" }).querySelectorAll(".si-overview-module-metric")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "SEO" }).querySelectorAll(".si-overview-module-metric")).toHaveLength(0);
  });

  it("按六模块与末尾 README 折叠卡排列，并把快捷操作放进页面操作区", async () => {
    await renderOverview(createMockApi());

    expect(await screen.findByRole("region", { name: "最近抓取任务记录" })).toBeTruthy();
    await screen.findByText("README · 项目概况");
    expect(await screen.findByRole("region", { name: "待办" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "快捷操作" })).toBeNull();
    expect(screen.getByRole("button", { name: "立即同步" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开项目文件夹" })).toBeTruthy();

    const content = document.querySelector(".si-overview-content");
    expect([...content!.children].map((element) => element.classList[0] || element.tagName.toLowerCase())).toEqual([
      "si-overview-modules", "si-overview-readme",
    ]);
    expect(screen.queryByRole("heading", { name: "需要关注" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "变更记录" })).toBeNull();
    expect(document.querySelector<HTMLDetailsElement>(".si-overview-readme")?.open).toBe(false);
    fireEvent.click(screen.getByText("README · 项目概况"));
    expect(document.querySelector<HTMLDetailsElement>(".si-overview-readme")?.open).toBe(true);
    expect(document.querySelector(".si-overview-content > .si-page-header")).toBeNull();
    expect(document.querySelector<HTMLDetailsElement>(".si-overview-instruction")?.open).toBe(false);
    expect(document.querySelector(".si-overview-instruction")?.textContent).toContain("Agent 接入指令");

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "校验本地数据文件" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "复制 agent 接入指令" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "打开 README" })).toBeTruthy();
  }, 10_000);

  it("项目头不重复展示同步时间和状态", async () => {
    const mockApi = createMockApi();
    const project = await mockApi.projects.get("demo");
    mockApi.projects.get = vi.fn(async () => ({
      ...project,
      summary: { ...project.summary, sync: { ...project.summary.sync, state: "ok" as const, at: new Date(2026, 10, 8, 17, 0).toISOString() } },
    }));
    await renderOverview(mockApi);

    expect(await screen.findByRole("region", { name: "SEO" })).toBeTruthy();
    expect(document.querySelector(".si-page-frame-project .si-project-header")).toBeTruthy();
    expect(document.querySelector(".si-project-header-sync")).toBeNull();
    expect(screen.queryByText("同步成功")).toBeNull();
    expect(screen.queryByText(/今天/)).toBeNull();
  });

  it("README 与任务记录没有内容时显示紧凑空状态", async () => {
    const mockApi = createMockApi();
    const overview = await mockApi.overview.get("demo");
    mockApi.overview.get = vi.fn(async () => ({
      ...overview,
      attention: [],
      readme: { ...overview.readme, overview: "", focus: "" },
      changelog: [],
    }));
    mockApi.jobs.history = vi.fn(async () => []);
    await renderOverview(mockApi);

    expect(await screen.findByText("暂无运行记录，可在运行页启动任务。")).toBeTruthy();
    expect(screen.getByText("暂无 README 项目概况。").classList.contains("si-overview-readme-empty")).toBe(true);
    expect(screen.queryByText("暂无变更记录。")).toBeNull();
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
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "pageRows", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["project-todos", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["inventory-summary", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["seo", "summary", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["content", "summary", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["content", "blogs", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["design", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["job-history", "demo"] }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects", "demo"], exact: true }));
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects"], exact: true }));
  });
});

describe("概览最近博客日期", () => {
  it("仅统计本地日历最近七天的有效发表日期", () => {
    const dates = ["2026-11-17", "2026-11-23", "2026-11-16", "2026-11-24", "2026-11-31", ""];
    expect(recentBlogCount(dates.map((published_at) => ({ published_at }) as BlogPost), new Date(2026, 10, 23))).toBe(2);
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

    expect(await screen.findByRole("region", { name: "SEO" })).toBeTruthy();
    expect(screen.queryByText("尚未填写 GMC feed")).toBeNull();
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
