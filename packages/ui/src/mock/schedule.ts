import type { SiteIndexApi } from "@siteindex/shared";
import { clone, projectCenterError, projectCenterErrorMode, projectKey, reply, scheduleStates } from "./context";

export function createScheduleMock(): SiteIndexApi["schedule"] {
  return {
    get: (id) => projectCenterErrorMode ? Promise.reject(projectCenterError()) : reply(scheduleStates[projectKey(id)]),
    save: (id, config) => reply(() => {
      const key = projectKey(id);
      scheduleStates[key] = { ...scheduleStates[key], config: clone(config), registered: true };
      return scheduleStates[key];
    }),
  };
}
