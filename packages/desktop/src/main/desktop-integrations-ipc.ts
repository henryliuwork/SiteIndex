import type { IpcHandlerImplementations } from "./ipc-registry.js";
import type { DesktopIntegrations } from "./desktop-integrations.js";
import type { SettingsStore } from "./settings-store.js";

export function createDesktopIntegrationIpcHandlers(
  settings: SettingsStore,
  desktopIntegrations: DesktopIntegrations,
): IpcHandlerImplementations {
  return {
    "settings.detectBrowser": async () => desktopIntegrations.detectBrowser((await settings.get()).browser),
    "settings.cliStatus": () => desktopIntegrations.cliStatus(),
    "settings.installCli": () => desktopIntegrations.installCli(),
  };
}
