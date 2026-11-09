import type { BrowserWindow, IpcMain, IpcMainEvent } from "electron";
import { TITLE_BAR_OVERLAY_COLOR_CHANNEL } from "../shared/titlebar-overlay-channel.js";

export interface TitleBarOverlayTarget {
  isDestroyed(): boolean;
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
}

export function setTitleBarOverlayColor(
  window: TitleBarOverlayTarget | null,
  color: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32" || window === null || window.isDestroyed()) return false;
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return false;

  window.setTitleBarOverlay({ color, symbolColor: "#1B1F24", height: 38 });
  return true;
}

export function bindTitleBarOverlayColor(
  ipcMain: Pick<IpcMain, "on" | "removeListener">,
  window: BrowserWindow,
): void {
  const listener = (event: IpcMainEvent, color: unknown): void => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
    setTitleBarOverlayColor(window, color);
  };

  ipcMain.on(TITLE_BAR_OVERLAY_COLOR_CHANNEL, listener);
  window.once("closed", () => ipcMain.removeListener(TITLE_BAR_OVERLAY_COLOR_CHANNEL, listener));
}
