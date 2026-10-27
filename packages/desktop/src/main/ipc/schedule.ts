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
        // 非执行设备只保存配置，不注册系统任务；提示由界面根据执行设备状态显示，
        // 不再弹出阻塞 IPC 的原生对话框。
        if (!runner.is_this_device) return { ...state, registered: false } satisfies ScheduleState;
        return state;
      }),
    "schedule.status": () => context.scheduler.getRuntimeStatus(),
    "schedule.reauthorize": () => context.reconcileSchedules(true),
  };
}
