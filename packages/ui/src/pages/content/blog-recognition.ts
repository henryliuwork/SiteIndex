import type { SiteConfig } from "@siteindex/shared";

type BlogRecognitionConfig = SiteConfig["content"];

const updatedAtKey = (projectId: string) => `siteindex:blog-recognition-config-updated-at:${projectId}`;

function normalizedValues(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function sameValues(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const normalizedLeft = normalizedValues(left);
  const normalizedRight = normalizedValues(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function blogRecognitionCounts(config: BlogRecognitionConfig | undefined) {
  return {
    sitemaps: normalizedValues(config?.blog_sitemaps).length,
    rules: normalizedValues(config?.blog_url_patterns).length,
  };
}

export function hasBlogRecognitionConfig(config: BlogRecognitionConfig | undefined): boolean {
  const counts = blogRecognitionCounts(config);
  return counts.sitemaps > 0 || counts.rules > 0;
}

export function didBlogRecognitionConfigChange(previous: BlogRecognitionConfig | undefined, next: BlogRecognitionConfig | undefined): boolean {
  return !sameValues(previous?.blog_sitemaps, next?.blog_sitemaps)
    || !sameValues(previous?.blog_url_patterns, next?.blog_url_patterns);
}

export function markBlogRecognitionConfigUpdated(projectId: string, updatedAt = Date.now()): void {
  try {
    window.localStorage.setItem(updatedAtKey(projectId), String(updatedAt));
  } catch {
    // Local storage may be disabled; the content page will avoid claiming an unknown config is stale.
  }
}

export function getBlogRecognitionConfigUpdatedAt(projectId: string): number | null {
  try {
    const value = window.localStorage.getItem(updatedAtKey(projectId));
    if (!value) return null;
    const updatedAt = Number(value);
    return Number.isFinite(updatedAt) ? updatedAt : null;
  } catch {
    return null;
  }
}

export function blogRecognitionNeedsRecrawl(
  configured: boolean,
  configUpdatedAt: number | null,
  latestSuccessfulWeeklyStartedAt: string | null,
): boolean {
  if (!configured) return false;
  if (!latestSuccessfulWeeklyStartedAt) return true;
  if (configUpdatedAt === null) return false;
  const lastStartedAt = Date.parse(latestSuccessfulWeeklyStartedAt);
  return !Number.isFinite(lastStartedAt) || lastStartedAt < configUpdatedAt;
}
