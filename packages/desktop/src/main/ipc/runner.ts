import { writeRunner } from "@siteindex/core";
import type { SiteIndexError } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

function desktopError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

export function createRunnerHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "runner.get": (id) => context.withProject(id, (projectId) => context.core.runner.get(projectId)),
    "runner.claim": (id) =>
      context.withProject(id, async (projectId) => {
        const projectPath = context.projects.resolveProject(projectId);
        const current = await context.settings.get();
        const nextRunner = {
          device_id: current.device_id,
          device_name: current.device_name,
          claimed_at: new Date().toISOString(),
        };
        await writeRunner(projectPath, nextRunner);
        context.core.invalidate(projectPath);
        // 认领执行设备只是写入 .runner.json；注册系统计划任务失败（例如未授权）不应回滚认领，
        // 否则界面会出现“认领报错，但计划状态又已变化”的不一致。注册状态由运行页的计划模式展示，
        // 用户可点“重新授权注册”重试。
        try {
          await context.onRunnerClaimed?.(projectId, projectPath);
        } catch (error) {
          throw desktopError(
            "WRITE_FAILED",
            "本机已设为执行设备，但系统计划任务注册失败。可在定时计划中点击“重新授权注册”重试。",
            error instanceof Error ? `${error.message}${"detail" in error && error.detail ? `\n${String(error.detail)}` : ""}` : String(error),
          );
        }
        return context.core.runner.get(projectId);
      }),
  };
}
