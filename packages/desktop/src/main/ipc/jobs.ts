import type { ProjectId } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";
import { invalidJobRequest, isJobRequest } from "./validators.js";

export function createJobsHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "jobs.run": (request) => {
      if (!isJobRequest(request)) throw invalidJobRequest("Job 请求无效。");
      return context.jobs.run(request);
    },
    "jobs.cancel": (runId) => {
      if (typeof runId !== "string" || !runId.trim()) throw invalidJobRequest("Job 标识无效。");
      return context.jobs.cancel(runId);
    },
    "jobs.history": (id, limit) => {
      if (typeof id !== "string" || !id.trim() || (limit !== undefined && typeof limit !== "number")) {
        throw invalidJobRequest("Job 历史查询参数无效。");
      }
      return context.jobs.history(id as ProjectId, limit as number | undefined);
    },
    "jobs.running": (id) => {
      if (typeof id !== "string" || !id.trim()) throw invalidJobRequest("项目标识无效。");
      return context.jobs.running(id as ProjectId);
    },
  };
}
