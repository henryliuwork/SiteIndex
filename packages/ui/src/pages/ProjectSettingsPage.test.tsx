// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { createMockApi } from "../mock";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.restoreAllMocks();
  vi.resetModules();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

async function renderSettings(initialEntry: string) {
  const mockApi = createMockApi();
  const updateConfig = vi.spyOn(mockApi.projects, "updateConfig");
  const saveCategories = vi.spyOn(mockApi.categories, "save");
  const validateFiles = vi.spyOn(mockApi.files, "validate");
  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
  }));

  const [{ ProjectSettingsConfigPage }, { ToastProvider }] = await Promise.all([
    import("./ProjectSettingsConfigPage"),
    import("../components/overlays"),
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes><Route path="/p/:id/settings/:section" element={<ProjectSettingsConfigPage />} /></Routes>
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { mockApi, updateConfig, saveCategories, validateFiles };
}

describe("项目设置单页区块", () => {
  it.each([
    ["/p/demo/settings/categories", "categories", "分类设置"],
    ["/p/demo/settings/files", "files", "本地文件校验"],
    ["/p/demo/settings/config?section=categories", "categories", "分类设置"],
  ])("旧入口 %s 仍落到统一设置页的 %s 区块", async (entry, section, heading) => {
    await renderSettings(entry);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(document.getElementById(section)).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "配置目录" }).querySelectorAll("button")).toHaveLength(12);
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getByTestId("location").textContent).toBe(entry);
  }, 20_000);

  it("保留配置、分类保存和本地文件校验操作，并在分类保存后保留未保存的配置草稿", async () => {
    const { updateConfig, saveCategories, validateFiles } = await renderSettings("/p/demo/settings/config");
    const domain = await screen.findByLabelText("域名") as HTMLInputElement;
    fireEvent.change(domain, { target: { value: "draft.example.test" } });

    fireEvent.click(await screen.findByRole("button", { name: "保存并重新归类" }));
    await waitFor(() => expect(saveCategories).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByLabelText("域名") as HTMLInputElement).value).toBe("draft.example.test"));

    fireEvent.click(await screen.findByRole("button", { name: "一键校验全部" }));
    await waitFor(() => expect(validateFiles).toHaveBeenCalledWith("demo"));

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("demo", expect.objectContaining({ domain: "draft.example.test" })));
  }, 20_000);
});
