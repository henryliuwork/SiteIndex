import type { ScheduleRuntimeStatus, SiteIndexApi, SystemTaskRow } from "@siteindex/shared";
import { clone, mockMode, projectCenterError, projectCenterErrorMode, projectKey, reply, scheduleStates } from "./context";

const scheduleRuntimeMode: ScheduleRuntimeStatus["mode"] = mockMode === "schedule-resident" ? "resident" : "system";
let scheduleAuthorizationRequired = mockMode === "schedule-authorization";
const orphanScheduleSeed = [{
  taskName: "SiteIndex-demo-orphan",
  path: "C:\\SiteIndex\\Projects\\Missing Demo",
  reason: "项目目录不存在。",
}];
const systemTaskSeed: SystemTaskRow[] = [
  {
    taskName: "SiteIndex-demo-daily",
    projectId: "demo",
    orphaned: false,
    job: "daily",
    systemState: "Ready",
    lastRunAt: "2026-11-06T02:00:00.000Z",
    lastResult: "成功",
    nextRunAt: "2026-11-07T02:00:00.000Z",
    triggerSummary: "每天 02:00",
    commandPath: "C:\\SiteIndex\\mock\\siteindex.exe",
    configMatches: false,
    differences: ["触发时间：系统 02:30，项目配置 02:00。"],
  },
  {
    taskName: "SiteIndex-demo2-weekly",
    projectId: "demo2",
    orphaned: false,
    job: "weekly",
    systemState: "Running",
    lastRunAt: "2026-11-02T03:00:00.000Z",
    lastResult: "成功",
    nextRunAt: "2026-11-09T03:00:00.000Z",
    triggerSummary: "每周一 03:00",
    commandPath: "C:\\SiteIndex\\mock\\siteindex.exe",
    configMatches: true,
    differences: [],
  },
  {
    taskName: "SiteIndex-demo-orphan",
    projectId: null,
    orphaned: true,
    job: "daily",
    systemState: "Disabled",
    lastRunAt: null,
    lastResult: null,
    nextRunAt: null,
    triggerSummary: "每天 04:00",
    commandPath: "C:\\SiteIndex\\Projects\\Missing Demo",
    configMatches: null,
    differences: ["项目目录不存在。"],
  },
];

export function createScheduleMock(): SiteIndexApi["schedule"] {
  const orphanSchedules = clone(orphanScheduleSeed);
  const systemTasks = clone(systemTaskSeed);
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
    listSystemTasks: () => reply(() => systemTasks),
    removeOrphan: (taskName) => reply(() => {
      const index = orphanSchedules.findIndex((task) => task.taskName === taskName);
      if (index >= 0) orphanSchedules.splice(index, 1);
      const systemTaskIndex = systemTasks.findIndex((task) => task.taskName === taskName);
      if (systemTaskIndex >= 0) systemTasks.splice(systemTaskIndex, 1);
    }),
  };
}
