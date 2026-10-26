import type { ScheduleRuntimeStatus, SiteIndexApi } from "@siteindex/shared";
import { clone, mockMode, projectCenterError, projectCenterErrorMode, projectKey, reply, scheduleStates } from "./context";

const scheduleRuntimeMode: ScheduleRuntimeStatus["mode"] = mockMode === "schedule-resident" ? "resident" : "system";
let scheduleAuthorizationRequired = mockMode === "schedule-authorization";

export function createScheduleMock(): SiteIndexApi["schedule"] {
  return {
    get: (id) => projectCenterErrorMode ? Promise.reject(projectCenterError()) : reply(scheduleStates[projectKey(id)]),
    save: (id, config) => reply(() => {
      const key = projectKey(id);
      scheduleStates[key] = { ...scheduleStates[key], config: clone(config), registered: true };
      return scheduleStates[key];
    }),
    status: () => reply<ScheduleRuntimeStatus>(() => ({ mode: scheduleRuntimeMode, authorization_required: scheduleAuthorizationRequired })),
    reauthorize: () => reply<ScheduleRuntimeStatus>(() => {
      scheduleAuthorizationRequired = false;
      return { mode: scheduleRuntimeMode, authorization_required: false };
    }),
  };
}
