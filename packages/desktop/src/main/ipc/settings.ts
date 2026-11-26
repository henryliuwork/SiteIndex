import { app, shell } from "electron";
import { mkdir } from "node:fs/promises";
import type { ConfigSaveOptions, SettingsPatch } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { sendDingTalkTestNotification } from "../notifications.js";
import { chooseDirectory } from "./app.js";
import { settingsIpcError } from "../error-detail.js";
import { desktopErrorLogEntry } from "../diagnostic-log.js";
import type { IpcContext } from "./context.js";

export function createSettingsHandlers(context: IpcContext): IpcHandlerImplementations {
  const handlers: IpcHandlerImplementations = {
    "settings.get": () => context.settings.get(),
    "settings.set": async (patch, options) => {
      const updated = await context.settings.set(patch as SettingsPatch, options as ConfigSaveOptions | undefined);
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
    "settings.detectBrowser": async () => context.desktopIntegrations.detectBrowser((await context.settings.get()).browser),
    "settings.cliStatus": () => context.desktopIntegrations.cliStatus(),
    "settings.installCli": () => context.desktopIntegrations.installCli(),
    "settings.chooseDirectory": (defaultPath) =>
      chooseDirectory(typeof defaultPath === "string" ? defaultPath : undefined),
  };
  return Object.fromEntries(Object.entries(handlers).map(([operation, handler]) => [operation,
    async (...args: unknown[]) => {
      try { return await handler(...args); }
      catch (error) {
        try { context.logError?.(desktopErrorLogEntry(operation, error)); } catch { /* Keep the original error. */ }
        throw settingsIpcError(operation, error);
      }
    },
  ])) as IpcHandlerImplementations;
}
