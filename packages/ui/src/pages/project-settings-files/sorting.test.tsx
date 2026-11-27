// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createMockApi } from "../../mock";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../../api");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("文件校验表保留分类分组且不显示无效排序按钮", async () => {
  const api = createMockApi();
  vi.doMock("../../api", () => ({ api, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
  const [{ ProjectSettingsFilesPage }, { ToastProvider }] = await Promise.all([
    import("../ProjectSettingsFilesPage"), import("../../components/overlays"),
  ]);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter initialEntries={["/p/demo/settings/files"]}>
      <Routes><Route path="/p/:id/settings/files" element={<ProjectSettingsFilesPage embedded />} /></Routes>
    </MemoryRouter></ToastProvider>
  </QueryClientProvider>);

  const table = await screen.findByRole("table");
  for (const name of ["文件", "类型", "记录", "大小", "最近修改", "状态", "操作"]) {
    expect(within(table).getByRole("columnheader", { name }).querySelector("button")).toBeNull();
  }
  expect(table.querySelector(".si-files-group-label")).toBeTruthy();
});
