import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMain, IpcMainEvent } from "electron";
import { bindTitleBarOverlayColor, setTitleBarOverlayColor } from "./titlebar-overlay.js";

describe("native title bar overlay colors", () => {
  it("updates only the background color while preserving Windows controls", () => {
    const setTitleBarOverlay = vi.fn();
    const window = { isDestroyed: () => false, setTitleBarOverlay };

    expect(setTitleBarOverlayColor(window, "#bcbdbd", "win32")).toBe(true);
    expect(setTitleBarOverlay).toHaveBeenCalledWith({ color: "#bcbdbd", symbolColor: "#1B1F24", height: 38 });
  });

  it("rejects invalid colors and ignores non-Windows windows", () => {
    const setTitleBarOverlay = vi.fn();
    const window = { isDestroyed: () => false, setTitleBarOverlay };

    expect(setTitleBarOverlayColor(window, "rgba(0,0,0,.5)", "win32")).toBe(false);
    expect(setTitleBarOverlayColor(window, "#fff", "win32")).toBe(false);
    expect(setTitleBarOverlayColor(window, "#bcbdbd", "darwin")).toBe(false);
    expect(setTitleBarOverlayColor({ isDestroyed: () => true, setTitleBarOverlay }, "#bcbdbd", "win32")).toBe(false);
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("accepts updates only from the owning window main frame", () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const setTitleBarOverlay = vi.fn();
    let onClosed: (() => void) | undefined;
    const window = {
      webContents,
      isDestroyed: () => false,
      setTitleBarOverlay,
      once: (_event: string, listener: () => void) => { onClosed = listener; },
    } as unknown as BrowserWindow;
    const listeners = new Map<string, (event: IpcMainEvent, color: unknown) => void>();
    const ipcMain = {
      on: vi.fn((channel: string, listener: (event: IpcMainEvent, color: unknown) => void) => listeners.set(channel, listener)),
      removeListener: vi.fn(),
    } as unknown as Pick<IpcMain, "on" | "removeListener">;

    bindTitleBarOverlayColor(ipcMain, window);
    const update = listeners.get("si:window.setTitleBarOverlayColor");
    expect(update).toBeDefined();
    update?.({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainEvent, "#bcbdbd");
    update?.({ sender: { mainFrame }, senderFrame: mainFrame } as unknown as IpcMainEvent, "#aaaaaa");
    update?.({ sender: webContents, senderFrame: {} } as unknown as IpcMainEvent, "#aaaaaa");

    expect(setTitleBarOverlay).toHaveBeenCalledTimes(1);
    onClosed?.();
    expect(ipcMain.removeListener).toHaveBeenCalledOnce();
  });
});
