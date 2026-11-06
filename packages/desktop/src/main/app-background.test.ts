import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  menu: null as unknown,
  listeners: {} as Record<string, () => void>,
  destroyed: false,
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getFileIcon: async () => ({ isEmpty: () => false }),
    getPath: () => "C:\\Test\\SiteIndex.exe",
  },
  Menu: {
    buildFromTemplate: (items: unknown) => items,
  },
  Tray: class {
    setToolTip(): void {}
    setContextMenu(menu: unknown): void {
      state.menu = menu;
    }
    on(event: string, listener: () => void): void {
      state.listeners[event] = listener;
    }
    destroy(): void {
      state.destroyed = true;
    }
  },
}));

interface MenuItem {
  label?: string;
  click?: () => void;
  submenu?: MenuItem[];
  enabled?: boolean;
}

afterEach(() => {
  state.menu = null;
  state.listeners = {};
  state.destroyed = false;
  vi.clearAllMocks();
});

describe("app tray", () => {
  it("shows the next plan and a per-project immediate sync action", async () => {
    const { createAppTray } = await import("./app-background.js");
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    const onSync = vi.fn();
    const controller = await createAppTray({
      onOpen,
      onQuit,
      onSync,
      listProjects: async () => [{ id: "fixture-shop", name: "fixture-shop" }],
      nextRunLabel: async () => "11/06 02:00 · 每日同步 · fixture-shop",
    });

    expect(controller).not.toBeNull();
    await controller!.refresh();

    const menu = state.menu as MenuItem[];
    expect(menu.map((item) => item.label)).toContain("下次计划：11/06 02:00 · 每日同步 · fixture-shop");
    const syncMenu = menu.find((item) => item.label === "立即同步");
    expect(syncMenu?.submenu?.[0]?.label).toBe("fixture-shop");
    syncMenu?.submenu?.[0]?.click?.();
    expect(onSync).toHaveBeenCalledWith("fixture-shop");
    state.listeners.click?.();
    expect(onOpen).toHaveBeenCalledOnce();
    controller?.destroy();
    expect(state.destroyed).toBe(true);
  });

  it("keeps exit available when no projects are registered", async () => {
    const { createAppTray } = await import("./app-background.js");
    const onQuit = vi.fn();
    const controller = await createAppTray({
      onOpen: vi.fn(),
      onQuit,
      onSync: vi.fn(),
      listProjects: async () => [],
      nextRunLabel: async () => "未配置",
    });
    await controller?.refresh();

    const menu = state.menu as MenuItem[];
    expect(menu.find((item) => item.label === "立即同步")?.enabled).toBe(false);
    menu.find((item) => item.label === "退出 SiteIndex")?.click?.();
    expect(onQuit).toHaveBeenCalledOnce();
    controller?.destroy();
  });
});
