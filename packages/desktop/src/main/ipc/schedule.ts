import { dialog } from "electron";
import type { ScheduleState } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";
import { invalidSchedule, isScheduleConfig } from "./validators.js";

export function createScheduleHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "schedule.get": async (id) =>
      context.withProject(id, async (projectId) => {
        const state = await context.core.schedule.get(projectId);
        return context.scheduler.getState(
          projectId,
          context.projects.resolveProject(projectId),
          state.config,
        );
      }),
    "schedule.save": async (id, config) =>
      context.withProject(id, async (projectId) => {
        if (!isScheduleConfig(config)) throw invalidSchedule();
        const saved = await context.core.schedule.save(projectId, config);
        const runner = await context.core.runner.get(projectId);
        await context.reconcileSchedules(true);
        const state = await context.scheduler.getState(
          projectId,
          context.projects.resolveProject(projectId),
          saved.config,
        );
        if (!runner.is_this_device) {
          await dialog.showMessageBox({
            type: "info",
            title: "计划已保存",
            message: "计划已写入项目配置，但本机不是此项目的执行设备。",
            detail: runner.runner
              ? `请在执行设备“${runner.runner.device_name}”上同步计划，任务将由该设备运行。`
              : "请先在要运行任务的设备上认领此项目。",
          });
          return { ...state, registered: false } satisfies ScheduleState;
        }
        return state;
      }),
  };
}
