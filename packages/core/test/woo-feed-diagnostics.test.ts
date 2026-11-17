import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type CreateProjectInput, type DetectResult } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { emptySnapshotReason, parseFeed, toSnapshot, type FeedSiteConfig } from "../src/crawl/gmc-feed";
import { readJsonl } from "../src/io/jsonl";
import { createProjectFiles } from "../src/projects/create";
import { createCoreService } from "../src/service";

const roots: string[] = [];
const site: FeedSiteConfig = { base_url: "https://shop.example.test", currency: "USD", crawl: {} };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("WooCommerce feed diagnostics", () => {
  it("parses products/product aliases and reports all filter counts without changing legacy stats", () => {
    const items = parseFeed(`<products>
      <product><sku>DEMO-A</sku><name>Demo A</name><product_url>/item/a</product_url><regular_price>12 USD</regular_price><stock_status>instock</stock_status></product>
      <product><sku>DEMO-A</sku><name>Duplicate</name><product_url>/item/a</product_url><regular_price>12 USD</regular_price></product>
      <product><name>No ID</name><product_url>/item/b</product_url><regular_price>14 USD</regular_price></product>
      <product><sku>DEMO-B</sku><product_url>/item/b</product_url></product>
    </products>`);
    const snapshot = toSnapshot(items, site, "2026-11-17");
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({ sku: "DEMO-A", title: "Demo A", url: "https://shop.example.test/item/a", price: 12, stock_status: "in_stock" });
    expect(snapshot.filtered).toEqual({ no_id: 1, duplicate: 1, missing_price_or_link: 1 });
    expect(snapshot.stats).toMatchObject({ no_id: 1, duplicate: 1, missing_price_or_link: 1, in_stock: 1 });
  });

  it("explains blog RSS, missing prices, and unsupported XML roots", () => {
    const blog = parseFeed('<rss><channel><item><guid>post-1</guid><title>Story</title><link>https://shop.example.test/story</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>');
    expect(emptySnapshotReason(blog, toSnapshot(blog, site))).toContain("疑似博客 RSS/Atom");
    const withoutPrice = parseFeed('<products><product><sku>DEMO-B</sku><url>/item/b</url></product></products>');
    expect(emptySnapshotReason(withoutPrice, toSnapshot(withoutPrice, site))).toContain("缺价格 1");
    expect(() => parseFeed('<urlset><url><loc>https://shop.example.test/item/a</loc></url></urlset>'))
      .toThrow(/根节点 <urlset>.*<item>.*<entry>.*<products>/);
  });

  it("returns a readable empty-feed reason through inspectFeed, daily and runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-feed-"));
    roots.push(root);
    const feedPath = path.join(root, "blog.xml");
    await writeFile(feedPath, '<rss><channel><item><guid>post-1</guid><title>Story</title><link>https://shop.example.test/story</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>');
    const detected: DetectResult = {
      input: "https://shop.example.test", final_url: "https://shop.example.test/", redirect_status: null,
      robots: { found: false, disallow_count: 0, sitemaps: [] }, sitemaps: [], total_urls: 0,
      platform: "woocommerce", platform_evidence: "test", frontend: null, locale: null, currency: "USD", feed_candidates: [],
    };
    const input: CreateProjectInput = {
      url: detected.input, feed_urls: [feedPath], sku_field: "id", category_depth: 1, missing_as: "out_of_stock",
      brand: { name: "Demo Shop" }, markets: ["US"], projects_root: root, folder_name: "demo-shop", workspace_folders: [],
    };
    const created = await createProjectFiles(input, detected);
    const service = createCoreService({ resolveProject: () => created.path, deviceId: "test-device", deviceName: "Test Device", cacheDir: path.join(root, "cache") });
    await expect(service.projects.inspectFeed([feedPath], { sku_field: "id", category_depth: 1 }))
      .rejects.toMatchObject({ code: "FEED_FETCH_FAILED", message: expect.stringContaining("疑似博客 RSS/Atom") });
    const result = await service.runJob({ projectPath: created.path, job: "daily", trigger: "manual", date: "2026-11-17" }, () => undefined);
    expect(result).toMatchObject({ status: "failed", errors: [expect.stringContaining("疑似博客 RSS/Atom")] });
    const runs = await readJsonl(path.join(created.path, PATHS.runs));
    expect(runs.find((row) => row.run_id === result.runId)).toMatchObject({ status: "failed", errors: [expect.stringContaining("疑似博客 RSS/Atom")] });
    expect(await readFile(path.join(created.path, PATHS.site), "utf8")).toContain("shop.example.test");
  }, 30_000);
});
