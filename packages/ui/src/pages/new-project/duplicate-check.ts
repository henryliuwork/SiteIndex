import type { ProjectSummary } from "@siteindex/shared";

export type ExistingProject = Pick<ProjectSummary, "id" | "name" | "domain">;

export function normalizeProjectDomain(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  const urlValue = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : "https://" + input;

  try {
    const url = new URL(urlValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    return hostname || null;
  } catch {
    return null;
  }
}

export function findExistingProject(
  projects: readonly ExistingProject[],
  ...siteUrls: string[]
): ExistingProject | null {
  const candidateDomains = new Set(siteUrls.map(normalizeProjectDomain).filter((domain): domain is string => domain !== null));
  if (!candidateDomains.size) return null;
  return projects.find((project) => {
    const domain = normalizeProjectDomain(project.domain);
    return domain !== null && candidateDomains.has(domain);
  }) ?? null;
}
