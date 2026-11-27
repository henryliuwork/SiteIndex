// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { CategoriesConfig } from "@siteindex/shared";
import { createMockApi } from "../../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../../api");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectSettingsCategoriesPage 排序审计", () => {
  it.fails("分类 URL 排序后应重新排列本地配置行", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const mockApi = createMockApi();
    const current = await mockApi.categories.get("demo");
    const config: CategoriesConfig = {
      ...current,
      mode: "manual",
      manual: [
        { slug: "demo-z-sort", name: "Zeta 虚构分类", url: "/z-category", match: [] },
        { slug: "demo-a-sort", name: "Alpha 虚构分类", url: "/a-category", match: [] },
      ],
    };
    mockApi.categories.get = vi.fn(async () => config);
    vi.doMock("../../api", () => ({
      api: mockApi,
      apiErrorMessage: (_error: unknown, fallback: string) => fallback,
    }));
    const [{ ProjectSettingsCategoriesPage }, { ToastProvider }] = await Promise.all([
      import("../ProjectSettingsCategoriesPage"),
      import("../../components/overlays"),
    ]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><MemoryRouter initialEntries={["/p/demo/settings/categories"]}>
          <Routes><Route path="/p/:id/settings/categories" element={<ProjectSettingsCategoriesPage />} /></Routes>
        </MemoryRouter></ToastProvider>
      </QueryClientProvider>,
    );

    const table = await screen.findByRole("table");
    await within(table).findByText("Zeta 虚构分类");
    fireEvent.click(within(table).getByRole("button", { name: "分类页 URL" }));

    await waitFor(() => {
      const first = table.querySelector(".si-table tbody tr[data-row-id] .si-category-name-cell strong")?.textContent;
      expect(first).toBe("Alpha 虚构分类");
    });
  });
});
