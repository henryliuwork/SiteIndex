import type { AppSettings } from "@siteindex/shared";

type BackgroundSettings = Pick<AppSettings, "close_to_tray" | "launch_at_login">;

export interface BackgroundPolicy {
  keepTray: boolean;
  hideOnClose: boolean;
  openAtLogin: boolean;
  backgroundAtLogin: boolean;
}

export function backgroundPolicy(
  settings: BackgroundSettings,
  scheduleMode: "system" | "resident",
  platform: NodeJS.Platform,
  hasProjects: boolean,
): BackgroundPolicy {
  const supportsTray = platform === "win32" || platform === "darwin";
  const closeToTray = settings.close_to_tray ?? true;
  const residentMode = platform === "win32" && scheduleMode === "resident";
  const residentNeeded = residentMode && hasProjects;
  return {
    keepTray: supportsTray && (closeToTray || residentMode),
    hideOnClose: supportsTray && closeToTray,
    openAtLogin: Boolean(settings.launch_at_login) || residentNeeded,
    backgroundAtLogin: residentNeeded,
  };
}
