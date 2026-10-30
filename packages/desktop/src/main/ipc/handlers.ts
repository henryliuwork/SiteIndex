import type { IpcHandlerImplementations } from "../ipc-registry.js";
import { createAppHandlers } from "./app.js";
import { createCategoriesHandlers } from "./categories.js";
import { createContentHandlers } from "./content.js";
import type { IpcContext } from "./context.js";
import { createDesignHandlers } from "./design.js";
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
import { createSkuHandlers } from "./sku.js";
import { createSkillsHandlers } from "./skills.js";
import { createUiStateHandlers } from "./ui-state.js";
import { createUpdatesHandlers } from "./updates.js";

export function createIpcHandlerImplementations(context: IpcContext): IpcHandlerImplementations {
  return {
    ...createAppHandlers(),
    ...createUpdatesHandlers(context),
    ...createSettingsHandlers(context),
    ...createUiStateHandlers(context),
    ...createProjectsHandlers(context),
    ...createOverviewHandlers(context),
    ...createInventoryHandlers(context),
    ...createProductsHandlers(context),
    ...createSkuHandlers(context),
    ...createSeoHandlers(context),
    ...createContentHandlers(context),
    ...createEdmHandlers(context),
    ...createDesignHandlers(context),
    ...createReadmeHandlers(context),
    ...createCategoriesHandlers(context),
    ...createFilesHandlers(context),
    ...createFoldersHandlers(context),
    ...createJobsHandlers(context),
    ...createScheduleHandlers(context),
    ...createRunnerHandlers(context),
    ...createShellHandlers(),
    ...createSkillsHandlers(context),
  };
}
