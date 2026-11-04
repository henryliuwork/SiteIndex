// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AttentionItem } from "@siteindex/shared";
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
  const { OverviewPage } = await import("./OverviewPage");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><MemoryRouter><OverviewPage /></MemoryRouter></QueryClientProvider>);
}

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
    const overviewGet = vi.fn(async () => ({ ...summary, attention }));
    mockApi.overview.get = overviewGet;
    const setRuleIgnored = vi.fn(async () => ({ updated: 2 }));
    mockApi.seo.setRuleIgnored = setRuleIgnored;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderOverview(mockApi);

    fireEvent.click(await screen.findByRole("button", { name: "忽略" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：全站同一规则"));
    await waitFor(() => expect(setRuleIgnored).toHaveBeenCalledWith("demo", "desc_missing", true));
    await waitFor(() => expect(overviewGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("已更新 2 条")).toBeTruthy();
  });
});
