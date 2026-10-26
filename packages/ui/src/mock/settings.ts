import type { BrowserStatus, CliStatus, SiteIndexApi } from "@siteindex/shared";
import { clone, projectCenterError, projectCenterErrorMode, reply, settingsState } from "./context";

export function createSettingsMock(): SiteIndexApi["settings"] {
  return {
    get: () => projectCenterErrorMode ? Promise.reject(projectCenterError()) : reply(settingsState),
    set: (patch) => reply(() => {
      Object.assign(settingsState, clone(patch));
      if (patch.browser) settingsState.browser = { ...settingsState.browser, ...patch.browser };
      if (patch.notify) settingsState.notify = { ...settingsState.notify, ...patch.notify };
      return settingsState;
    }),
    detectBrowser: () => reply<BrowserStatus>({ available: true, name: "Microsoft Edge mock", path: "C:/Program Files/Microsoft/Edge/Application/msedge.exe" }),
    cliStatus: () => reply<CliStatus>({ installed: false, path: "C:/SiteIndex/bin/siteindex.cmd" }),
    installCli: () => reply<CliStatus>({ installed: true, path: "C:/SiteIndex/bin/siteindex.cmd" }),
    chooseDirectory: (defaultPath) => reply(defaultPath ?? "C:/SiteIndex/Projects"),
    sendTestNotification: () => reply(undefined),
    openLogs: () => reply(undefined),
  };
}
