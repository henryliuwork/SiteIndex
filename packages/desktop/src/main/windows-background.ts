import { app, Menu, Tray } from "electron";

export const backgroundSchedulerArgument = "--siteindex-background";

export function updateWindowsAutostart(enabled: boolean): boolean {
  if (process.platform !== "win32") return true;
  if (!app.isPackaged) return true;
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [backgroundSchedulerArgument] });
    return app.getLoginItemSettings({ args: [backgroundSchedulerArgument] }).openAtLogin;
  } catch (error) {
    console.warn("无法设置 Windows 用户登录自启。", error);
    return false;
  }
}

export async function createWindowsTray(onOpen: () => void, onQuit: () => void): Promise<Tray | null> {
  try {
    const icon = await app.getFileIcon(app.getPath("exe"), { size: "small" });
    if (icon.isEmpty()) throw new Error("应用图标为空。");
    const tray = new Tray(icon);
    tray.setToolTip("SiteIndex 正在后台检查计划任务。");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 SiteIndex", click: onOpen },
        { type: "separator" },
        { label: "退出 SiteIndex", click: onQuit },
      ]),
    );
    tray.on("click", onOpen);
    tray.on("double-click", onOpen);
    return tray;
  } catch (error) {
    console.error("创建 SiteIndex 系统托盘失败。", error);
    return null;
  }
}
