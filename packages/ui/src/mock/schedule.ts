import type { ScheduleRuntimeStatus, SiteIndexApi } from "@siteindex/shared";
import { clone, mockMode, projectCenterError, projectCenterErrorMode, projectKey, reply, scheduleStates } from "./context";

const scheduleRuntimeMode: ScheduleRuntimeStatus["mode"] = mockMode === "schedule-resident" ? "resident" : "system";
let scheduleAuthorizationRequired = mockMode === "schedule-authorization";
const orphanScheduleSeed = [{
  taskName: "SiteIndex-demo-orphan",
  path: "C:\\SiteIndex\\Projects\\Missing Demo",
  reason: "项目目录不存在。",
}];

export function createScheduleMock(): SiteIndexApi["schedule"] {
  const orphanSchedules = clone(orphanScheduleSeed);
  const verificationResults = new Map<string, { state: "ok" | "unregistered" | "path_mismatch" | "orphaned" | "error"; message?: string; repaired?: boolean }>();
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
    verify: (id, options) => reply(() => {
      const key = projectKey(id);
      const current = verificationResults.get(id) ?? (key === "demo"
        ? { state: "path_mismatch" as const, message: "系统计划任务仍指向旧项目路径。" }
        : scheduleStates[key].registered
          ? { state: "ok" as const }
          : { state: "unregistered" as const, message: "尚未注册系统计划任务。" });
      if (options?.repair && current.state === "path_mismatch") {
        scheduleStates[key] = { ...scheduleStates[key], registered: true };
        const repaired = { state: "ok" as const, repaired: true, message: "系统计划任务路径已修复。" };
        verificationResults.set(id, repaired);
        return repaired;
      }
      verificationResults.set(id, current);
      return current;
    }),
    listOrphans: () => reply(() => orphanSchedules),
    removeOrphan: (taskName) => reply(() => {
      const index = orphanSchedules.findIndex((task) => task.taskName === taskName);
      if (index >= 0) orphanSchedules.splice(index, 1);
    }),
  };
}
