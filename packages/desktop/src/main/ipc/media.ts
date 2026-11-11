import type { JobRequest, ProjectId, SiteIndexError } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

function invalidMediaRequest(): SiteIndexError {
  return { code: "CONFIG_INVALID", message: "媒体准备请求无效。" };
}

export function createMediaHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "media.prepare": (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalidMediaRequest();
      const record = input as Record<string, unknown>;
      const skus = record.skus;
      if (
        typeof record.project !== "string" ||
        !Array.isArray(skus) ||
        skus.some((sku: unknown) => typeof sku !== "string" || !sku.trim())
      )
        throw invalidMediaRequest();
      const request = { project: record.project, skus: skus as string[] };
      return context.withProject(request.project, async (id) => {
        const job: Omit<JobRequest, "trigger"> & { job: "media" } = {
          projectPath: context.projects.resolveProject(id),
          job: "media",
          skus: request.skus,
        };
        return context.jobs.runMedia(job);
      });
    },
  };
}
