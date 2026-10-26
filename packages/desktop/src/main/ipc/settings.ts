import type { AppSettings } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
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
    "settings.chooseDirectory": (defaultPath) =>
      chooseDirectory(typeof defaultPath === "string" ? defaultPath : undefined),
  };
}
