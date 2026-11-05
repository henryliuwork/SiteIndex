import { dialog } from "electron";
import type { ScheduleState } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";
import { invalidSchedule, isScheduleConfig } from "./validators.js";
import type { ScheduleRuntimeStatus } from "../scheduler/schedule.js";

export function createScheduleHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "schedule.get": async (id) =>
      context.withProject(id, async (projectId) => {
        const state = await context.core.schedule.get(projectId);
        return context.scheduler.getState(projectId, context.projects.resolveProject(projectId), state.config);
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
    "schedule.verify": async (id, options) =>
      context.withProject(id, async (projectId) => {
        await context.waitForProjectScheduleReconciliation?.(projectId);
        const [schedule, runner] = await Promise.all([
          context.core.schedule.get(projectId),
          context.core.runner.get(projectId),
        ]);
        const definition = {
          projectId,
          projectPath: context.projects.resolveProject(projectId),
          config: schedule.config,
          isThisDevice: runner.is_this_device,
        };
        let verification = await context.scheduler.verify(definition);
        let repaired = false;
        if (
          options &&
          typeof options === "object" &&
          "repair" in options &&
          options.repair === true &&
          verification.state !== "ok"
        ) {
          let status: ScheduleRuntimeStatus;
          try {
            status = await context.reconcileSchedules(true);
          } catch (error) {
            return {
              state: "error" as const,
              message: `计划任务修复失败：${error instanceof Error ? error.message : String(error)}`,
              repaired: false,
            };
          }
          if (status.authorization_required) {
            return {
              state: "error" as const,
              message: "计划任务需要管理员授权，授权后请重新核验。",
              repaired: false,
            };
          }
          verification = await context.scheduler.verify(definition);
          repaired = verification.state === "ok";
        }
        return {
          ...verification,
          ...(options && typeof options === "object" && "repair" in options && options.repair === true
            ? { repaired }
            : {}),
        };
      }),
    "schedule.status": () => context.scheduler.getRuntimeStatus(),
    "schedule.reauthorize": () => context.reconcileSchedules(true),
    "schedule.listOrphans": async () => {
      const entries = await context.projects.refresh(await context.settings.get());
      return context.scheduler.listOrphans(entries.map(({ path: projectPath }) => ({ projectPath })));
    },
    "schedule.removeOrphan": async (taskName) => {
      if (typeof taskName !== "string" || !taskName.replace(/^\\+/, "").toLowerCase().startsWith("siteindex")) {
        throw { code: "CONFIG_INVALID", message: "只能清理名称以 SiteIndex 开头的计划任务。" };
      }
      const entries = await context.projects.refresh(await context.settings.get());
      const orphans = await context.scheduler.listOrphans(entries.map(({ path: projectPath }) => ({ projectPath })));
      const orphan = orphans.find(({ taskName: candidate }) => candidate.toLowerCase() === taskName.toLowerCase());
      if (!orphan) throw { code: "PROJECT_NOT_FOUND", message: "该计划任务不在孤立任务列表中。" };
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "清理孤立计划任务",
        message: `确认删除计划任务“${orphan.taskName}”吗？`,
        detail: `项目路径：${orphan.path}\n原因：${orphan.reason}`,
        buttons: ["取消", "删除任务"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return;
      await context.scheduler.removeOrphan(orphan.taskName);
    },
  };
}
