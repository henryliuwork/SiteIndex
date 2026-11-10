// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PATHS } from "@siteindex/shared";
import { createMockApi } from "../mock";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function renderDesignPage(mockApi: ReturnType<typeof createMockApi>) {
  vi.doMock("../api", () => ({ api: mockApi, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
  const [{ DesignPage }, { ToastProvider }] = await Promise.all([import("./DesignPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><DesignPage /></MemoryRouter></QueryClientProvider></ToastProvider>);
}

describe("DesignPage Token v2 颜色与字体", () => {
  it("显示角色来源、置信度和完整字号，并保留打开 tokens.json", async () => {
    const mockApi = createMockApi();
    const project = await mockApi.projects.get("demo");
    const openPath = vi.spyOn(mockApi.shell, "openPath");
    await renderDesignPage(mockApi);

    expect(await screen.findByRole("heading", { name: "颜色角色" })).toBeTruthy();
    expect(screen.getByText("主色")).toBeTruthy();
    expect(document.querySelector(".si-design-role-content code")?.textContent).toBe("--color-primary");
    expect(screen.getByText("置信度：98%")).toBeTruthy();
    expect(screen.getByText("当前页面未识别此颜色角色。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "字体与字号层级" })).toBeTruthy();
    expect(screen.getByText("一级标题 H1")).toBeTruthy();
    expect(screen.getByText("六级标题 H6")).toBeTruthy();
    expect(screen.getByText("说明 Caption")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开 tokens.json" }));
    expect(openPath).toHaveBeenCalledWith(`${project.summary.path}/${PATHS.designTokens}`);
    expect(await screen.findByText("已打开 tokens.json。")).toBeTruthy();
  }, 15_000);

  it("缺少 Token v2 角色和字号时显示明确空状态", async () => {
    const mockApi = createMockApi();
    mockApi.design.get = vi.fn(async () => ({ tokens: null, screenshots: [] }));
    await renderDesignPage(mockApi);

    expect(await screen.findByText("暂无颜色角色数据")).toBeTruthy();
    expect(screen.getByText("暂无字号层级。当前 tokens.json 尚未提供 Token v2 字号数据。")).toBeTruthy();
  });
});
