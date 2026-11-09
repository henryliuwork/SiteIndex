import { app, Menu, Tray, type MenuItemConstructorOptions } from "electron";

export const backgroundSchedulerArgument = "--siteindex-background";

export function updateLoginAutostart(enabled: boolean, background: boolean): boolean {
  if (process.platform !== "win32" && process.platform !== "darwin") return true;
  if (!app.isPackaged) return true;
  try {
    if (process.platform === "win32") {
      const args = background ? [backgroundSchedulerArgument] : [];
      app.setLoginItemSettings({ openAtLogin: enabled, args });
      return app.getLoginItemSettings({ args }).openAtLogin === enabled;
    }
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin === enabled;
  } catch (error) {
    console.warn("无法设置用户登录自启。", error);
    return false;
  }
}

export interface AppTray {
  refresh(): Promise<void>;
  destroy(): void;
}

export interface TrayProject {
  id: string;
  name: string;
}

export interface AppTrayOptions {
  onOpen(): void;
  onQuit(): void;
  onSync(id: string): void;
  listProjects(): Promise<TrayProject[]>;
  nextRunLabel(): Promise<string>;
}

export async function createAppTray(options: AppTrayOptions): Promise<AppTray | null> {
  try {
    const icon = await app.getFileIcon(app.getPath("exe"), { size: "small" });
    if (icon.isEmpty()) throw new Error("应用图标为空。");
    const tray = new Tray(icon);
    tray.setToolTip("SiteIndex");
    let destroyed = false;
    const refresh = async (): Promise<void> => {
      const [projectsResult, nextRunResult] = await Promise.allSettled([
        options.listProjects(),
        options.nextRunLabel(),
      ]);
      if (destroyed) return;
      const projects = projectsResult.status === "fulfilled" ? projectsResult.value : [];
      const nextRun = nextRunResult.status === "fulfilled" ? nextRunResult.value : "读取失败";
      const syncMenu: MenuItemConstructorOptions[] = projects.map((project) => ({
        label: project.name || project.id,
        click: () => options.onSync(project.id),
      }));
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "打开 SiteIndex", click: options.onOpen },
        { label: `下次计划：${nextRun}`, enabled: false },
        { label: "立即同步", enabled: syncMenu.length > 0, submenu: syncMenu },
        { type: "separator" },
        { label: "退出 SiteIndex", click: options.onQuit },
      ]));
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 SiteIndex", click: options.onOpen },
      { label: "下次计划：正在读取", enabled: false },
      { label: "立即同步", enabled: false },
      { type: "separator" },
      { label: "退出 SiteIndex", click: options.onQuit },
    ]));
    tray.on("click", options.onOpen);
    tray.on("double-click", options.onOpen);
    tray.on("right-click", () => void refresh());
    const timer = setInterval(() => void refresh(), 60_000);
    timer.unref();
    void refresh();
    return {
      refresh,
      destroy() {
        destroyed = true;
        clearInterval(timer);
        tray.destroy();
      },
    };
  } catch (error) {
    console.error("创建 SiteIndex 系统托盘失败。", error);
    return null;
  }
}
