import type { QueryClient } from "@tanstack/react-query";
import type { ProjectId, SiteConfig } from "@siteindex/shared";

export async function invalidateInventoryForCategoryChange(
  queryClient: QueryClient,
  projectId: ProjectId,
  previous: SiteConfig["categories"],
  next: SiteConfig["categories"],
): Promise<void> {
  if (JSON.stringify(previous) === JSON.stringify(next)) return;

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["inventory-summary", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["inventory-skus", projectId] }),
  ]);
}
