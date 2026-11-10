// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

async function renderProductsPage() {
  const mockApi = createMockApi();
  vi.doMock("../api", () => ({
    api: mockApi,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
  }));
  const [{ ProductsPage }, { ToastProvider }] = await Promise.all([import("./ProductsPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ToastProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/demo/products"]}>
          <Routes><Route path="/p/:id/products" element={<ProductsPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
  return mockApi;
}

describe("ProductsPage 页面操作区", () => {
  it("把导出与 SKU 规则操作放进项目页头，不渲染重复 PageHeader", async () => {
    await renderProductsPage();

    expect(await screen.findByRole("button", { name: "导出 CSV" })).toBeTruthy();
    expect(document.querySelector(".si-products-page > .si-tab-panel .si-page-header")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "SKU 父子规则设置" })).toBeTruthy();
  });
});
