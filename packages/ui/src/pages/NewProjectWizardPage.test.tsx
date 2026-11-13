// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { SiteIndexApi } from "@siteindex/shared";
import { createMockApi } from "../mock";

const pendingWizardHandlers = [
  "workspace.check",
  "workspace.create",
];

function mockWorkspaceCapabilities(pendingHandlers: readonly string[]) {
  vi.doMock("./workspace-capabilities", async () => {
    const actual = await vi.importActual<typeof import("./workspace-capabilities")>("./workspace-capabilities");
    return {
      ...actual,
      getWorkspaceCapabilities: (api: SiteIndexApi, isMockApi: boolean) =>
        actual.getWorkspaceCapabilities(api, isMockApi, pendingHandlers),
    };
  });
}

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.doUnmock("./workspace-capabilities");
  vi.resetModules();
});

function LocationProbe() {
  return <output data-testid="current-route">{useLocation().pathname}</output>;
}

describe("NewProjectWizardPage workspace step", () => {
  it("checks the selected destination and sends the workspace options with project creation", async () => {
    const mockApi = createMockApi();
    const createProject = vi.spyOn(mockApi.projects, "create");
    const inspectFeed = vi.spyOn(mockApi.projects, "inspectFeed");
    const checkWorkspace = vi.spyOn(mockApi.workspace!, "check");
    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: false,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    mockWorkspaceCapabilities([]);
    const [{ NewProjectWizardPage }, { WizardDraftProvider }, { ToastProvider }] = await Promise.all([
      import("./NewProjectWizardPage"), import("./wizard-state"), import("../components/overlays"),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <WizardDraftProvider>
            <MemoryRouter initialEntries={["/new/url"]}>
              <Routes><Route path="/new/*" element={<NewProjectWizardPage />} /></Routes>
              <LocationProbe />
            </MemoryRouter>
          </WizardDraftProvider>
        </QueryClientProvider>
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "检测" }));
    const nextToSource = await screen.findByRole("button", { name: "下一步：数据源" });
    await waitFor(() => expect((nextToSource as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToSource);
    fireEvent.click(await screen.findByRole("button", { name: "检测 Feed" }));
    await screen.findByText("可用 SKU");
    expect(inspectFeed).toHaveBeenCalledWith(["https://kingsyard.com/products.json"], expect.any(Object));
    const nextToBrand = screen.getByRole("button", { name: "下一步：品牌配置" });
    await waitFor(() => expect((nextToBrand as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToBrand);
    expect(await screen.findByText(/仅支持本机存储。第三方同步目录可能无法识别/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "下一步：Agent 工作区" }));

    expect((await screen.findByRole("checkbox", { name: /创建 Agent 工作区/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Mailchimp" }) as HTMLInputElement).checked).toBe(true);
    await screen.findByText("目标目录为空，可以继续。");
    await waitFor(() => expect(checkWorkspace).toHaveBeenCalledWith("D:/SiteIndex/projects/kingsyard"));
    expect(screen.getByRole("heading", { name: "将生成的目录树" })).toBeTruthy();
    const preview = screen.getByText((_content, element) => element?.tagName === "PRE");
    expect(preview.textContent).toContain("_site-index/");
    expect(preview.textContent).toContain("esp.mailchimp.md");

    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      feed_urls: ["https://kingsyard.com/products.json"],
      workspace: { enabled: true, platform: "shopify", esp_presets: ["mailchimp"] },
    })));
    await waitFor(() => expect(screen.getByTestId("current-route").textContent).toBe("/new/done"));
  }, 30_000);

  it("creates a project with no feed when the user chooses to configure it later", async () => {
    const mockApi = createMockApi();
    mockApi.workspace = undefined;
    const createProject = vi.spyOn(mockApi.projects, "create");
    const inspectFeed = vi.spyOn(mockApi.projects, "inspectFeed");
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ NewProjectWizardPage }, { WizardDraftProvider }, { ToastProvider }] = await Promise.all([
      import("./NewProjectWizardPage"), import("./wizard-state"), import("../components/overlays"),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <WizardDraftProvider>
            <MemoryRouter initialEntries={["/new/url"]}>
              <Routes><Route path="/new/*" element={<NewProjectWizardPage />} /></Routes>
              <LocationProbe />
            </MemoryRouter>
          </WizardDraftProvider>
        </QueryClientProvider>
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "检测" }));
    const nextToSource = await screen.findByRole("button", { name: "下一步：数据源" });
    await waitFor(() => expect((nextToSource as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToSource);
    fireEvent.click(await screen.findByRole("button", { name: "跳过 Feed，稍后配置" }));

    expect(await screen.findByText("创建项目后可在项目设置补充。未配置 Feed 时，首次每日同步可能失败。")).toBeTruthy();
    expect(screen.getByTestId("current-route").textContent).toBe("/new/brand");
    await waitFor(() => {
      expect((screen.getByLabelText("品牌名") as HTMLInputElement).value).toBe("Kingsyard");
      expect((screen.getByLabelText(/项目根目录/) as HTMLInputElement).value).toBe("D:/SiteIndex/projects");
      expect((screen.getByLabelText("项目文件夹名") as HTMLInputElement).value).toBe("kingsyard");
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ feed_urls: [] })));
    expect(inspectFeed).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("current-route").textContent).toBe("/new/done"));
    expect(await screen.findByText("创建项目后可在项目设置补充。首次每日同步可能失败，完成页会显示每一步的实际结果。")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "创建完成，但有步骤失败", level: 1 })).toBeTruthy(), { timeout: 10_000 });
    expect(screen.getByText("首次每日同步失败：尚未配置 GMC Feed。")).toBeTruthy();
  }, 30_000);

  it("keeps the workspace step hidden when the optional API is absent", async () => {
    const mockApi = createMockApi();
    mockApi.workspace = undefined;
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ NewProjectWizardPage }, { WizardDraftProvider }, { ToastProvider }] = await Promise.all([
      import("./NewProjectWizardPage"), import("./wizard-state"), import("../components/overlays"),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><WizardDraftProvider><MemoryRouter initialEntries={["/new/url"]}><Routes><Route path="/new/*" element={<NewProjectWizardPage />} /></Routes></MemoryRouter></WizardDraftProvider></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "检测" }));
    const nextToSource = await screen.findByRole("button", { name: "下一步：数据源" });
    await waitFor(() => expect((nextToSource as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToSource);
    fireEvent.click(await screen.findByRole("button", { name: "检测 Feed" }));
    await screen.findByText("可用 SKU");
    const nextToBrand = screen.getByRole("button", { name: "下一步：品牌配置" });
    await waitFor(() => expect((nextToBrand as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToBrand);

    expect(await screen.findByRole("button", { name: "创建项目" })).toBeTruthy();
    expect(screen.queryByText("Agent 工作区")).toBeNull();
  }, 30_000);

  it("keeps a pending Desktop workspace stub unavailable and explains the limitation", async () => {
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: false, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    mockWorkspaceCapabilities(pendingWizardHandlers);
    const [{ NewProjectWizardPage }, { WizardDraftProvider }, { ToastProvider }] = await Promise.all([
      import("./NewProjectWizardPage"), import("./wizard-state"), import("../components/overlays"),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><WizardDraftProvider><MemoryRouter initialEntries={["/new/url"]}><Routes><Route path="/new/*" element={<NewProjectWizardPage />} /></Routes></MemoryRouter></WizardDraftProvider></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "检测" }));
    const nextToSource = await screen.findByRole("button", { name: "下一步：数据源" });
    await waitFor(() => expect((nextToSource as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToSource);
    fireEvent.click(await screen.findByRole("button", { name: "检测 Feed" }));
    await screen.findByText("可用 SKU");
    const nextToBrand = screen.getByRole("button", { name: "下一步：品牌配置" });
    await waitFor(() => expect((nextToBrand as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(nextToBrand);

    expect(await screen.findByText("桌面端尚未接入工作区检查和创建操作；仍可继续创建并初始化 SiteIndex 项目。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下一步：Agent 工作区" })).toBeNull();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeTruthy();
  }, 30_000);
});
