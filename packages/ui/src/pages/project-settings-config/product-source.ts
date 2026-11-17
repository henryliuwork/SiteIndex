import type { SiteConfig } from "@siteindex/shared";

export function hasFeedlessProductCollection(config: SiteConfig | undefined): boolean {
  if (!config || config.crawl.auto_collect_products !== true) return false;
  const feeds = Array.isArray(config.crawl.feed_url) ? config.crawl.feed_url : [config.crawl.feed_url];
  return !feeds.some((url) => url.trim());
}
