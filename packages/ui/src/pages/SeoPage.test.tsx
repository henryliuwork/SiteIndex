// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createMockApi } from "../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("SeoPage 概览跳转筛选", () => {
  it("从 rule 和 status 参数恢复问题类型并在下拉中回显选中项", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });

    const mockApi = createMockApi();
    const listIssues = vi.spyOn(mockApi.seo, "listIssues");
    vi.doMock("../api", () => ({
      api: mockApi,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const { SeoPage } = await import("./SeoPage");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/demo/seo?rule=desc_missing&status=open"]}>
          <Routes><Route path="/p/:id/seo" element={<SeoPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "问题类型 · 已选 1" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "移除筛选：状态 · 待处理" })).toBeTruthy();
    await waitFor(() => expect(listIssues).toHaveBeenCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ rules: ["desc_missing"], status: "open" }),
    })));

    fireEvent.click(screen.getByRole("button", { name: "问题类型 · 已选 1" }));
    const selectedRule = await screen.findByRole("checkbox", { name: /Meta description 缺失/ });
    expect((selectedRule as HTMLInputElement).checked).toBe(true);
  });
});
