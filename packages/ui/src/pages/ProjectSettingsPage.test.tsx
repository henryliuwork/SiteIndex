// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { SiteConfig } from "@siteindex/shared";
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

async function renderSettings(initialEntry: string, omitGsc = false, initialGscProperty?: string) {
  const mockApi = createMockApi();
  if (omitGsc) mockApi.gsc = undefined;
  if (initialGscProperty) {
    const originalGetProject = mockApi.projects.get.bind(mockApi.projects);
    vi.spyOn(mockApi.projects, "get").mockImplementation(async (id) => {
      const project = await originalGetProject(id);
      return {
        ...project,
        config: {
          ...project.config,
          integrations: {
            ...project.config.integrations,
            gsc: { ...project.config.integrations?.gsc, property_site_url: initialGscProperty, keep_fixture_value: true },
          },
        },
      };
    });
    await mockApi.gsc?.connect();
    await mockApi.gsc?.selectProperty("demo", initialGscProperty);
  }
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
  it("无 Feed 商品采集开关可保存到抓取配置", async () => {
    const { updateConfig } = await renderSettings("/p/demo2/settings/config?section=crawl");
    const toggle = await screen.findByRole("checkbox", { name: "无 Feed 时自动采集商品" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByRole("button", { name: "自动采集商品说明" })).toBeTruthy();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("demo2", expect.objectContaining({
      crawl: expect.objectContaining({ feed_url: "", auto_collect_products: true }),
    })));
  }, 20_000);

  it("WooCommerce 与 WordPress 平台可分别显示并保存", async () => {
    const { updateConfig } = await renderSettings("/p/demo2/settings/config");
    const platform = await screen.findByLabelText("平台") as HTMLSelectElement;
    expect(platform.value).toBe("woocommerce");
    expect([...platform.options].map((option) => option.value)).toContain("wordpress");
    fireEvent.change(platform, { target: { value: "wordpress" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("demo2", expect.objectContaining({ platform: "wordpress" })));
  }, 30_000);

  it("逐条编辑多个分类前缀，预览只显示 Core 返回的匹配结果", async () => {
    const { saveCategories } = await renderSettings("/p/demo2/settings/config?section=categories");
    const first = await screen.findByRole("textbox", { name: "分类 URL 规则 1" }) as HTMLInputElement;
    expect(first.value).toBe("/shop/{slug}");
    expect((screen.getByRole("textbox", { name: "分类 URL 规则 2" }) as HTMLInputElement).value).toBe("/product-category/{slug}");
    expect(screen.getByRole("button", { name: "分类 URL 前缀说明" })).toBeTruthy();
    await screen.findByText("预览匹配 2 个分类");

    fireEvent.click(screen.getByRole("button", { name: "+ 添加前缀" }));
    fireEvent.change(screen.getByRole("textbox", { name: "分类 URL 规则 3" }), { target: { value: "/collections/{slug}" } });
    expect(screen.getByText("规则已修改，预览后可查看匹配的分类。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "预览匹配结果" }));
    await screen.findByText("预览匹配 3 个分类");

    fireEvent.click(screen.getByRole("button", { name: "删除分类 URL 规则 2" }));
    expect((screen.getByRole("textbox", { name: "分类 URL 规则 2" }) as HTMLInputElement).value).toBe("/collections/{slug}");
    fireEvent.click(screen.getByRole("button", { name: "保存并重新归类" }));
    await waitFor(() => expect(saveCategories).toHaveBeenCalledWith("demo2", expect.objectContaining({
      url_pattern: "/shop/{slug}, /collections/{slug}",
    })));
  }, 20_000);

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

  it("选择 GSC 属性 B 后保存其他设置时保留 B 和其他未保存草稿", async () => {
    const { updateConfig } = await renderSettings(
      "/p/demo/settings/config",
      false,
      "sc-domain:demo.example.test",
    );
    updateConfig.mockImplementation(async (_id, config) => config as SiteConfig);

    const propertySelect = await screen.findByRole("combobox", { name: "Search Console 属性" });
    fireEvent.click(propertySelect);
    fireEvent.click(await screen.findByRole("option", { name: "https://store.demo.example.test/ · 完全用户" }));
    fireEvent.change(await screen.findByLabelText("一句话定位"), { target: { value: "保留的未保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("demo", expect.objectContaining({
      brand: expect.objectContaining({ tagline: "保留的未保存草稿" }),
      integrations: expect.objectContaining({
        gsc: expect.objectContaining({ property_site_url: "https://store.demo.example.test/", keep_fixture_value: true }),
      }),
    })));
  }, 20_000);

  it("清除 GSC 属性后保存其他设置时不把旧属性写回去", async () => {
    const { updateConfig } = await renderSettings(
      "/p/demo/settings/config",
      false,
      "sc-domain:demo.example.test",
    );
    updateConfig.mockImplementation(async (_id, config) => config as SiteConfig);

    const propertySelect = await screen.findByRole("combobox", { name: "Search Console 属性" });
    fireEvent.click(propertySelect);
    fireEvent.click(await screen.findByRole("option", { name: "清除当前属性选择" }));
    fireEvent.change(await screen.findByLabelText("一句话定位"), { target: { value: "清除后保留的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledOnce());
    const savedConfig = updateConfig.mock.calls[0]?.[1];
    expect(savedConfig?.brand?.tagline).toBe("清除后保留的草稿");
    expect(savedConfig?.integrations?.gsc).toEqual({ keep_fixture_value: true });
  }, 20_000);
});
