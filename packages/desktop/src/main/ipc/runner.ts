import { unlink } from "node:fs/promises";
import path from "node:path";
import { dialog } from "electron";
import { writeRunner } from "@siteindex/core";
import { PATHS, type ProjectId, type SiteIndexError } from "@siteindex/shared";
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
        const previous = await context.core.runner.get(projectId);
        const nextRunner = {
          device_id: current.device_id,
          device_name: current.device_name,
          claimed_at: new Date().toISOString(),
        };
        await writeRunner(projectPath, nextRunner);
        context.core.invalidate(projectPath);
        try {
          await context.onRunnerClaimed?.(projectId, projectPath);
        } catch (error) {
          if (previous.runner) await writeRunner(projectPath, previous.runner).catch(() => undefined);
          else await unlink(path.join(projectPath, PATHS.runner)).catch(() => undefined);
          context.core.invalidate(projectPath);
          throw desktopError("WRITE_FAILED", "本机计划任务注册失败，已恢复原执行设备。", String(error));
        }
        await dialog.showMessageBox({
          type: "info",
          title: "执行设备已更新",
          message: "本机已认领为此项目的执行设备。",
          detail:
            previous.runner && previous.runner.device_id !== current.device_id
              ? `原执行设备“${previous.runner.device_name}”上的计划任务在同步到新认领状态后会自动跳过。`
              : "项目计划任务将在本机同步并执行。",
        });
        return context.core.runner.get(projectId);
      }),
  };
}
