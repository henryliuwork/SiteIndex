import type { CoreService } from "@siteindex/core";
import type { AppSettings, ProjectId, SiteIndexError } from "@siteindex/shared";
import type { JobManager } from "../job-manager.js";
import type { ProjectCatalog } from "../project-catalog.js";
import type { ScheduleRuntimeStatus, SystemScheduler } from "../scheduler/schedule.js";
import type { SettingsStore } from "../settings-store.js";
import type { UiStateStore } from "../ui-state-store.js";
import type { SkillService } from "../skill-service.js";

export interface IpcDependencies {
  settings: SettingsStore;
  uiState: UiStateStore;
  core: CoreService;
  projects: ProjectCatalog;
  settingsChanged: (value: AppSettings) => Promise<void>;
  jobs: JobManager;
  scheduler: SystemScheduler;
  reconcileSchedules: (allowElevation: boolean) => Promise<ScheduleRuntimeStatus>;
  onRunnerClaimed?: (id: ProjectId, projectPath: string) => Promise<void>;
  skills: SkillService;
}

export interface IpcContext extends IpcDependencies {
  withProject<T>(value: unknown, callback: (id: ProjectId) => Promise<T>): Promise<T>;
}

export function createIpcContext(dependencies: IpcDependencies): IpcContext {
  return {
    ...dependencies,
    async withProject<T>(value: unknown, callback: (id: ProjectId) => Promise<T>): Promise<T> {
      if (typeof value !== "string" || !value.trim()) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "项目标识无效。",
          detail: String(value),
        } satisfies SiteIndexError;
      }
      const id = value as ProjectId;
      await dependencies.projects.ensureProject(id, await dependencies.settings.get());
      return callback(id);
    },
  };
}
