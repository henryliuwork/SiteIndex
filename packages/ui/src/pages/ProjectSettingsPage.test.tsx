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

async function renderSettings(initialEntry: string, omitGsc = false) {
  const mockApi = createMockApi();
  if (omitGsc) mockApi.gsc = undefined;
  const originalUpdateConfig = mockApi.projects.updateConfig.bind(mockApi.projects);
  const updateConfig = vi.spyOn(mockApi.projects, "updateConfig").mockImplementation(originalUpdateConfig);
  const originalSaveCategories = mockApi.categories.save.bind(mockApi.categories);
  const saveCategories = vi.spyOn(mockApi.categories, "save").mockImplementation(async (id, config) => {
    const result = await originalSaveCategories(id, config);
    const currentProject = await mockApi.projects.get(id);
    await originalUpdateConfig(id, { ...currentProject.config, categories: config });
    return result;
  });
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

  it("分类识别保存只提交已保存的 watched，保留未保存关注分类和配置草稿", async () => {
    const { mockApi, updateConfig, saveCategories, validateFiles } = await renderSettings("/p/demo/settings/config");
    const domain = await screen.findByLabelText("域名") as HTMLInputElement;
    fireEvent.change(domain, { target: { value: "saved.example.test" } });
    fireEvent.change(screen.getByPlaceholderText("例如：户外灯具"), { target: { value: "自定义关注分类" } });
    fireEvent.change(screen.getByPlaceholderText("例如：outdoor-lights"), { target: { value: "demo-watched-category" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/collections/lights"), { target: { value: "https://demo-store.example.test/collections/demo-watched-category" } });
    fireEvent.click(screen.getByRole("button", { name: "添加关注分类" }));

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("demo", expect.objectContaining({
      categories: expect.objectContaining({ watched: expect.arrayContaining([expect.objectContaining({ slug: "demo-watched-category" })]) }),
    })));
    await waitFor(async () => expect((await mockApi.projects.get("demo")).config.categories.watched).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "demo-watched-category" })])));

    updateConfig.mockClear();
    fireEvent.change(screen.getByPlaceholderText("例如：户外灯具"), { target: { value: "未保存关注分类" } });
    fireEvent.change(screen.getByPlaceholderText("例如：outdoor-lights"), { target: { value: "unsaved-watched-category" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/collections/lights"), { target: { value: "https://demo-store.example.test/collections/unsaved-watched-category" } });
    fireEvent.click(screen.getByRole("button", { name: "添加关注分类" }));

    fireEvent.change(screen.getByLabelText("一句话定位"), { target: { value: "尚未保存的品牌草稿" } });

    fireEvent.click(await screen.findByRole("button", { name: "保存并重新归类" }));
    await waitFor(() => expect(saveCategories).toHaveBeenCalledOnce());
    await waitFor(async () => expect((await mockApi.projects.get("demo")).config.categories.watched).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "demo-watched-category" })])));
    expect((await mockApi.projects.get("demo")).config.categories.watched).not.toEqual(expect.arrayContaining([expect.objectContaining({ slug: "unsaved-watched-category" })]));
    expect(saveCategories).toHaveBeenCalledWith("demo", expect.objectContaining({
      watched: expect.arrayContaining([expect.objectContaining({ slug: "demo-watched-category" })]),
    }));
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByText("未保存关注分类")).toBeTruthy();
    expect((screen.getByLabelText("一句话定位") as HTMLInputElement).value).toBe("尚未保存的品牌草稿");

    fireEvent.click(await screen.findByRole("button", { name: "一键校验全部" }));
    await waitFor(() => expect(validateFiles).toHaveBeenCalledWith("demo"));
  }, 20_000);

  it("旧 Desktop bridge 缺少 GSC 方法时仍能编辑并保存本地项目配置", async () => {
    const { updateConfig } = await renderSettings("/p/demo/settings/config", true);

    expect(await screen.findByText(/不影响本页其他项目设置/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("一句话定位"), { target: { value: "本地设置仍可使用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("demo", expect.objectContaining({
      brand: expect.objectContaining({ tagline: "本地设置仍可使用" }),
    })));
  }, 20_000);
});
