import { QueryClient } from "@tanstack/react-query";
import type { JobResult, ProjectId, SiteIndexApi } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { projectQueryKeys, subscribeToProjectChanges, subscribeToProjectJobCompletion } from "./project-queries";

function queryClientWithProjectSummaries() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(projectQueryKeys.list, [{ id: "riverstone" }, { id: "kingsyard" }]);
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
    const jobsApi: Pick<SiteIndexApi["jobs"], "onFinished"> = {
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
});