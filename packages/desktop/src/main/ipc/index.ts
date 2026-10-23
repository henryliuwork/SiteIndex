import { ipcMain } from "electron";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import { createAppHandlers } from "./app.js";
import { createContentHandlers } from "./content.js";
import { createIpcContext, type IpcDependencies } from "./context.js";
import { createEdmHandlers } from "./edm.js";
import { createFilesHandlers } from "./files.js";
import { createFoldersHandlers } from "./folders.js";
import { createInventoryHandlers } from "./inventory.js";
import { createJobsHandlers } from "./jobs.js";
import { createOverviewHandlers } from "./overview.js";
import { createProductsHandlers } from "./products.js";
import { createProjectsHandlers } from "./projects.js";
import { createReadmeHandlers } from "./readme.js";
import { createRunnerHandlers } from "./runner.js";
import { createScheduleHandlers } from "./schedule.js";
import { createSeoHandlers } from "./seo.js";
import { createSettingsHandlers } from "./settings.js";
import { createShellHandlers } from "./shell.js";
import { createSkillsHandlers } from "./skills.js";
import { createUiStateHandlers } from "./ui-state.js";

export function registerIpcHandlers(dependencies: IpcDependencies): void {
  const context = createIpcContext(dependencies);
  const handlers = createHandlerRegistry({
    ...createAppHandlers(),
    ...createSettingsHandlers(context),
    ...createUiStateHandlers(context),
    ...createProjectsHandlers(context),
    ...createOverviewHandlers(context),
    ...createInventoryHandlers(context),
    ...createProductsHandlers(context),
    ...createSeoHandlers(context),
    ...createContentHandlers(context),
    ...createEdmHandlers(context),
    ...createReadmeHandlers(context),
    ...createFilesHandlers(context),
    ...createFoldersHandlers(context),
    ...createJobsHandlers(context),
    ...createScheduleHandlers(context),
    ...createRunnerHandlers(context),
    ...createShellHandlers(),
    ...createSkillsHandlers(context),
  });

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    });
  }
}
