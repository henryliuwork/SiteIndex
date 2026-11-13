import path from "node:path";
import type { GscSyncInput, GscSyncResult } from "@siteindex/shared";
import { pathsForProject } from "../io/project-layout";
import { syncSearchAnalytics, type GscAnalyticsOptions } from "./search-analytics";

/** Credentials stay in the caller; only analytics history is stored in the project. */
export type GscProjectSyncOptions = Omit<GscAnalyticsOptions, "historyPath">;

/** Sync analytics for either project layout using its registered local history path. */
export async function syncProjectSearchAnalytics(
  projectPath: string,
  input: GscSyncInput,
  options: GscProjectSyncOptions,
): Promise<GscSyncResult> {
  const paths = await pathsForProject(projectPath);
  return syncSearchAnalytics(input, { ...options, historyPath: path.join(projectPath, paths.gscSearchAnalytics) });
}
