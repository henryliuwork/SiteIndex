import { QueryClient } from "@tanstack/react-query";
import type { JobProgress, JobResult, ProjectId, SiteIndexApi } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { projectQueryKeys, subscribeToProjectChanges, subscribeToProjectJobCompletion } from "./project-queries";

function queryClientWithProjectSummaries() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(projectQueryKeys.list, [
    { id: "riverstone", path: "C:/SiteIndex/riverstone" },
    { id: "kingsyard", path: "C:/SiteIndex/kingsyard" },
  ]);
  queryClient.setQueryData(projectQueryKeys.detail("riverstone"), { id: "riverstone" });
  queryClient.setQueryData(projectQueryKeys.detail("kingsyard"), { id: "kingsyard" });
  return queryClient;
}

describe("project summary query invalidation", () => {
  it("invalidates the project list and the changed project's detail when onChanged fires", () => {
    const queryClient = queryClientWithProjectSummaries();
    let notifyChanged: ((id: ProjectId) => void) | undefined;
    const projectsApi: Pick<SiteIndexApi["projects"], "onChanged"> = {
      onChanged: (callback) => {
        notifyChanged = callback;
        return () => { notifyChanged = undefined; };
      },
    };
    const unsubscribe = subscribeToProjectChanges(projectsApi, queryClient);

    notifyChanged?.("riverstone");

    expect(queryClient.getQueryState(projectQueryKeys.list)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(projectQueryKeys.detail("riverstone"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(projectQueryKeys.detail("kingsyard"))?.isInvalidated).toBe(false);

    unsubscribe();
    queryClient.clear();
  });

  it("invalidates the list and all project details when any job finishes", () => {
    const queryClient = queryClientWithProjectSummaries();
    let finishJob: ((result: JobResult) => void) | undefined;
    const jobsApi: Pick<SiteIndexApi["jobs"], "onProgress" | "onFinished"> = {
      onProgress: () => () => undefined,
      onFinished: (callback) => {
        finishJob = callback;
        return () => { finishJob = undefined; };
      },
    };
    const unsubscribe = subscribeToProjectJobCompletion(jobsApi, queryClient);

    finishJob?.({ runId: "run-1", job: "daily", status: "ok", exitCode: 0, summary: "完成" });

    expect(queryClient.getQueryState(projectQueryKeys.list)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(projectQueryKeys.detail("riverstone"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(projectQueryKeys.detail("kingsyard"))?.isInvalidated).toBe(true);

    unsubscribe();
    queryClient.clear();
  });

  it.each(["ok", "failed"] as const)("invalidates only the finished project's data after a %s run", (status) => {
    const queryClient = queryClientWithProjectSummaries();
    const keys = [
      ["products-merged", "riverstone", "all"], ["inventory-skus-merged", "riverstone", "all"],
      ["edm", "images", "riverstone", { page: 1 }], ["seo", "pageRows", "riverstone", { page: 1 }],
      ["content", "blogs", "riverstone", { page: 1 }], ["products", "changes", "riverstone", "SKU-1"],
      ["edm", "scenario", "candidates", "riverstone"],
    ];
    const otherKeys = keys.map((key) => key.map((value) => value === "riverstone" ? "kingsyard" : value));
    for (const key of [...keys, ...otherKeys]) queryClient.setQueryData(key, { rows: [] });
    let notifyProgress: ((event: JobProgress) => void) | undefined;
    let finishJob: ((result: JobResult) => void) | undefined;
    const unsubscribe = subscribeToProjectJobCompletion({
      onProgress: (callback) => { notifyProgress = callback; return () => { notifyProgress = undefined; }; },
      onFinished: (callback) => { finishJob = callback; return () => { finishJob = undefined; }; },
    }, queryClient);

    notifyProgress?.({ runId: "run-2", projectPath: "C:\\SiteIndex\\riverstone\\", job: "daily", pct: 50, level: "info", message: "处理中", at: "2026-11-27T00:00:00Z" });
    finishJob?.({ runId: "run-2", job: "daily", status, exitCode: status === "ok" ? 0 : 1, summary: "已结束" });

    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of otherKeys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(projectQueryKeys.list)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(projectQueryKeys.detail("kingsyard"))?.isInvalidated).toBe(true);
    unsubscribe();
    queryClient.clear();
  });

  it("keeps other projects' data intact when a finished run has no progress identity", () => {
    const queryClient = queryClientWithProjectSummaries();
    const dataKey = ["content", "blogs", "riverstone"];
    queryClient.setQueryData(dataKey, { rows: [] });
    let finishJob: ((result: JobResult) => void) | undefined;
    const unsubscribe = subscribeToProjectJobCompletion({
      onProgress: () => () => undefined,
      onFinished: (callback) => { finishJob = callback; return () => undefined; },
    }, queryClient);
    finishJob?.({ runId: "unknown", job: "weekly", status: "failed", exitCode: 1, summary: "未运行" });
    expect(queryClient.getQueryState(dataKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(projectQueryKeys.list)?.isInvalidated).toBe(true);
    unsubscribe();
    queryClient.clear();
  });
});
