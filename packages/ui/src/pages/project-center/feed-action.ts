import type { ProjectSummary, SiteConfig } from "@siteindex/shared";

export type FeedConfigurationStatus = "configured" | "missing" | "unknown";
export type ProjectWarningAction = "feed" | "runs" | "project" | null;

export function feedConfigurationStatus(feedUrl: SiteConfig["crawl"]["feed_url"] | null | undefined): FeedConfigurationStatus {
  if (feedUrl === undefined || feedUrl === null) return "unknown";
  const urls = Array.isArray(feedUrl) ? feedUrl : [feedUrl];
  return urls.some((url) => url.trim().length > 0) ? "configured" : "missing";
}

export function projectWarningAction(
  project: Pick<ProjectSummary, "sync" | "attention">,
  feedStatus: FeedConfigurationStatus,
  now = Date.now(),
): ProjectWarningAction {
  if (feedStatus === "missing") return "feed";
  if (feedStatus === "unknown") return null;

  const stale = project.sync.at !== null && now - new Date(project.sync.at).getTime() > 36 * 60 * 60 * 1000;
  if (project.sync.state === "failed" || project.sync.state === "partial" || project.sync.state === "never" || stale) return "runs";
  return "project";
}
