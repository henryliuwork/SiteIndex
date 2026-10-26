import { app, shell } from "electron";
import { mkdir } from "node:fs/promises";
import type { AppSettings } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { sendDingTalkTestNotification } from "../notifications.js";
import { chooseDirectory } from "./app.js";
import type { IpcContext } from "./context.js";

export function createSettingsHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "settings.get": () => context.settings.get(),
    "settings.set": async (patch) => {
      const updated = await context.settings.set(patch as Partial<AppSettings>);
      await context.settingsChanged(updated);
      return updated;
    },
    "settings.sendTestNotification": async () => {
      const settings = await context.settings.get();
      await sendDingTalkTestNotification(settings.notify.dingtalk_webhook);
    },
    "settings.openLogs": async () => {
      const logsDirectory = app.getPath("logs");
      await mkdir(logsDirectory, { recursive: true });
      const error = await shell.openPath(logsDirectory);
      if (error) throw { code: "UNKNOWN", message: "无法打开应用日志目录。" };
    },
    "settings.chooseDirectory": (defaultPath) =>
      chooseDirectory(typeof defaultPath === "string" ? defaultPath : undefined),
  };
}
