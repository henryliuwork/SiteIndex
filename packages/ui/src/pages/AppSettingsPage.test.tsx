// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AppSettings } from "@siteindex/shared";
import { createMockApi } from "../mock";

type CredentialState = "configured" | "not_configured" | "needs_reentry" | "unavailable";
interface CredentialBridgeMock {
  status: ReturnType<typeof vi.fn<(siteUrl: string) => Promise<{ state: CredentialState }>>>;
  save: ReturnType<typeof vi.fn<(input: { siteUrl: string; username: string; applicationPassword: string }) => Promise<void>>>;
  clear: ReturnType<typeof vi.fn<(siteUrl: string) => Promise<void>>>;
  states: Map<string, CredentialState>;
}

function createCredentialBridge(initial: CredentialState = "not_configured"): CredentialBridgeMock {
  const states = new Map<string, CredentialState>();
  const status = vi.fn(async (siteUrl: string) => ({ state: states.get(siteUrl) ?? initial }));
  const save = vi.fn(async ({ siteUrl }: { siteUrl: string; username: string; applicationPassword: string }) => {
    states.set(siteUrl, "configured");
  });
  const clear = vi.fn(async (siteUrl: string) => { states.set(siteUrl, "not_configured"); });
  return { status, save, clear, states };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "siteindexWindow");
  vi.doUnmock("../api");
  vi.resetModules();
});

async function renderSettings(options: { settings?: AppSettings; wordpress?: boolean; bridge?: CredentialBridgeMock | null } = {}) {
  const mockApi = createMockApi({ wordpressImageHostDemo: options.wordpress ?? false });
  const defaultSettings = await mockApi.settings.get();
  let savedSettings = options.settings ?? defaultSettings;
  vi.spyOn(mockApi.settings, "get").mockImplementation(async () => savedSettings);
  const save = vi.spyOn(mockApi.settings, "set").mockImplementation(async (patch) => {
    savedSettings = { ...savedSettings, ...patch };
    return savedSettings;
  });
  if (options.bridge) {
    Object.defineProperty(window, "siteindexWindow", { configurable: true, value: { wordpressCredentials: options.bridge } });
  }
  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
    apiErrorDetails: (error: unknown) => {
      if (typeof error !== "object" || error === null || typeof (error as { message?: unknown }).message !== "string") return null;
      const value = error as { message: string; code?: unknown };
      return { message: value.message, ...(typeof value.code === "string" ? { code: value.code } : {}) };
    },
  }));
  const [{ AppSettingsPage }, { ToastProvider }] = await Promise.all([
    import("./AppSettingsPage"),
    import("../components/overlays"),
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter><AppSettingsPage /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { mockApi, save };
}

describe("AppSettingsPage background options", () => {
  it("shows and persists the tray and launch-at-login options", async () => {
    const { save } = await renderSettings();
    const closeToTray = await screen.findByRole("checkbox", { name: /关闭窗口时最小化到托盘/ });
    const launchAtLogin = screen.getByRole("checkbox", { name: /开机时启动 SiteIndex/ });

    expect((closeToTray as HTMLInputElement).checked).toBe(true);
    expect((launchAtLogin as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("该功能将在后续版本提供。")).toBeNull();

    fireEvent.click(closeToTray);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ close_to_tray: false }));
    fireEvent.click(launchAtLogin);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ launch_at_login: true }));
  });

  it("hides background options when the optional settings are not supplied", async () => {
    const defaults = await createMockApi().settings.get();
    const { close_to_tray: _closeToTray, launch_at_login: _launchAtLogin, ...legacySettings } = defaults;
    await renderSettings({ settings: legacySettings });

    await screen.findByRole("heading", { name: "常规" });
    expect(screen.queryByRole("checkbox", { name: /关闭窗口时最小化到托盘/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /开机时启动 SiteIndex/ })).toBeNull();
  });

  it("loads only projects configured for WordPress image hosting and shows local-only mock disclosure", async () => {
    await renderSettings({ wordpress: true, bridge: createCredentialBridge() });
    await screen.findByRole("heading", { name: "WordPress 图片托管凭据" });
    expect(await screen.findByText("https://demo-store.example.test")).toBeTruthy();
    expect(screen.getByText("尚未配置")).toBeTruthy();
    expect(screen.getByText(/输入不会保存到本机或项目文件/)).toBeTruthy();
    expect(screen.getByText(/媒体上传接口尚未实现/)).toBeTruthy();
    expect(screen.queryByText("https://demo-catalog.example.test")).toBeNull();
  });

  it("configures and replaces credentials, then rereads status without echoing the password", async () => {
    const bridge = createCredentialBridge();
    await renderSettings({ wordpress: true, bridge });
    const origin = "https://demo-store.example.test";
    await screen.findByRole("button", { name: "配置凭据" });
    expect(bridge.status).toHaveBeenCalledWith(origin);

    fireEvent.click(screen.getByRole("button", { name: "配置凭据" }));
    fireEvent.change(await screen.findByLabelText("WordPress 用户名"), { target: { value: "fictional-user" } });
    fireEvent.change(screen.getByLabelText("应用程序密码"), { target: { value: "not-a-real-password" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到本机" }));

    await screen.findByText(/本机凭据已保存。此状态不代表 WordPress 已验证/);
    expect(bridge.save).toHaveBeenCalledWith({ siteUrl: origin, username: "fictional-user", applicationPassword: "not-a-real-password" });
    await waitFor(() => expect(bridge.status.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(document.querySelector('input[type="password"]')).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "替换凭据" }));
    expect((await screen.findByLabelText("WordPress 用户名") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("应用程序密码") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("WordPress 用户名"), { target: { value: "replacement-user" } });
    fireEvent.change(screen.getByLabelText("应用程序密码"), { target: { value: "another-fake-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到本机" }));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(2));
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("deletes one origin from the local vault and refreshes its status", async () => {
    const bridge = createCredentialBridge("configured");
    await renderSettings({ wordpress: true, bridge });
    fireEvent.click(await screen.findByRole("button", { name: "删除本机凭据" }));
    expect(await screen.findByText(/不会更改项目文件或其他网站的凭据/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "删除本机凭据" }).at(-1)!);
    await waitFor(() => expect(bridge.clear).toHaveBeenCalledWith("https://demo-store.example.test"));
    expect(await screen.findByText("尚未配置")).toBeTruthy();
  });

  it("shows state read errors with their code and allows retry", async () => {
    const bridge = createCredentialBridge();
    bridge.status.mockRejectedValueOnce({ code: "VAULT_READ_FAILED", message: "安全存储读取失败。" });
    await renderSettings({ wordpress: true, bridge });
    expect(await screen.findByText(/读取凭据状态失败：安全存储读取失败。（VAULT_READ_FAILED）/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("尚未配置")).toBeTruthy();
  });

  it("clears both inputs after a failed save and keeps the error separate from the secret", async () => {
    const bridge = createCredentialBridge();
    bridge.save.mockRejectedValueOnce({ code: "VAULT_WRITE_FAILED", message: "本机安全存储写入失败。" });
    await renderSettings({ wordpress: true, bridge });
    fireEvent.click(await screen.findByRole("button", { name: "配置凭据" }));
    fireEvent.change(await screen.findByLabelText("WordPress 用户名"), { target: { value: "fictional-user" } });
    fireEvent.change(screen.getByLabelText("应用程序密码"), { target: { value: "must-not-be-echoed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到本机" }));
    expect(await screen.findByText(/本机安全存储写入失败。（VAULT_WRITE_FAILED）/)).toBeTruthy();
    expect((screen.getByLabelText("WordPress 用户名") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("应用程序密码") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("must-not-be-echoed");
  });

  it("hides credential actions when secure storage is unavailable", async () => {
    const bridge = createCredentialBridge("unavailable");
    await renderSettings({ wordpress: true, bridge });
    expect(await screen.findByText("安全存储不可用")).toBeTruthy();
    expect(screen.getByText(/本机安全存储不可用/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "配置凭据" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(bridge.status.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("shows no configure action when the optional bridge is missing", async () => {
    await renderSettings({ wordpress: true, bridge: null });
    expect(await screen.findByText("安全存储不可用")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "配置凭据" })).toBeNull();
  });
});
