// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AppSettings } from "@siteindex/shared";
import { createMockApi } from "../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.resetModules();
});

async function renderSettings(settingsOverride?: AppSettings) {
  const mockApi = createMockApi();
  const defaultSettings = await mockApi.settings.get();
  let savedSettings = settingsOverride ?? defaultSettings;
  vi.spyOn(mockApi.settings, "get").mockImplementation(async () => savedSettings);
  const save = vi.spyOn(mockApi.settings, "set").mockImplementation(async (patch) => {
    savedSettings = { ...savedSettings, ...patch };
    return savedSettings;
  });
  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
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
    await renderSettings(legacySettings);

    await screen.findByRole("heading", { name: "常规" });
    expect(screen.queryByRole("checkbox", { name: /关闭窗口时最小化到托盘/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /开机时启动 SiteIndex/ })).toBeNull();
  });
});
