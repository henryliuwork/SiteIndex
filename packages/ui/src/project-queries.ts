import type { QueryClient } from "@tanstack/react-query";
import type { ProjectId, ProjectSummary, SiteIndexApi, Unsubscribe } from "@siteindex/shared";

export const projectQueryKeys = {
  list: ["projects"] as const,
  detail: (id: ProjectId) => ["projects", id] as const,
};

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
  jobsApi: Pick<SiteIndexApi["jobs"], "onFinished">,
  queryClient: QueryClient,
): Unsubscribe {
  return jobsApi.onFinished(() => {
    void invalidateAllProjectSummaries(queryClient);
  });
}