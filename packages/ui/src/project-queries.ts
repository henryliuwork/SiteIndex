import type { QueryClient } from "@tanstack/react-query";
import type { ProjectId, ProjectSummary, SiteIndexApi, Unsubscribe } from "@siteindex/shared";

export const projectQueryKeys = {
  list: ["projects"] as const,
  detail: (id: ProjectId) => ["projects", id] as const,
};

const projectDataKeys = new Set([
  "products-merged", "product", "product-tags", "inventory-summary", "inventory-skus",
  "inventory-skus-merged", "inventory-detail-skus",
]);

function projectPathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isProjectDataQuery(queryKey: readonly unknown[], id: ProjectId): boolean {
  const root = queryKey[0];
  if (root === "seo" || root === "content" || root === "edm") {
    return queryKey[root === "edm" && queryKey[1] === "scenario" ? 3 : 2] === id;
  }
  if (root === "products" && (queryKey[1] === "changes" || queryKey[1] === "skuBrief" || queryKey[1] === "groupFamily")) {
    return queryKey[2] === id;
  }
  return typeof root === "string" && projectDataKeys.has(root) && queryKey[1] === id;
}

export async function invalidateProjectDataQueries(queryClient: QueryClient, id: ProjectId): Promise<void> {
  await queryClient.invalidateQueries({ predicate: ({ queryKey }) => isProjectDataQuery(queryKey, id) });
}

export async function invalidateProjectSummary(queryClient: QueryClient, id: ProjectId): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.list, exact: true }),
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.detail(id), exact: true }),
  ]);
}

export async function invalidateAllProjectSummaries(queryClient: QueryClient): Promise<void> {
  const listedIds = queryClient.getQueryData<ProjectSummary[]>(projectQueryKeys.list)?.map(({ id }) => id) ?? [];
  const cachedIds = queryClient.getQueryCache().findAll({ queryKey: projectQueryKeys.list })
    .map((query) => query.queryKey[1])
    .filter((id): id is ProjectId => typeof id === "string");
  const projectIds = new Set([...listedIds, ...cachedIds]);

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.list, exact: true }),
    ...[...projectIds].map((id) => queryClient.invalidateQueries({ queryKey: projectQueryKeys.detail(id), exact: true })),
  ]);
}

export function subscribeToProjectChanges(
  projectsApi: Pick<SiteIndexApi["projects"], "onChanged">,
  queryClient: QueryClient,
): Unsubscribe {
  return projectsApi.onChanged((id) => {
    void invalidateProjectSummary(queryClient, id);
  });
}

export function subscribeToProjectJobCompletion(
  jobsApi: Pick<SiteIndexApi["jobs"], "onProgress" | "onFinished">,
  queryClient: QueryClient,
): Unsubscribe {
  const pathsByRunId = new Map<string, string>();
  const stopProgress = jobsApi.onProgress(({ runId, projectPath }) => {
    pathsByRunId.set(runId, projectPathKey(projectPath));
  });
  const stopFinished = jobsApi.onFinished(({ runId }) => {
    const projectPath = pathsByRunId.get(runId);
    pathsByRunId.delete(runId);
    const projectId = projectPath && queryClient.getQueryData<ProjectSummary[]>(projectQueryKeys.list)
      ?.find(({ path }) => projectPathKey(path) === projectPath)?.id;
    void invalidateAllProjectSummaries(queryClient);
    if (projectId) void invalidateProjectDataQueries(queryClient, projectId);
  });
  return () => { stopProgress(); stopFinished(); pathsByRunId.clear(); };
}
