import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig, type SkuRecord } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonl, writeJsonl } from "../src/io/jsonl";
import { runWeekly } from "../src/jobs/weekly";
import { createCoreService } from "../src/service";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureServer(): Promise<string> {
  const pages: Record<string, { status?: number; type: string; body: string }> = {};
  const server = createServer((request, response) => {
    const current = pages[request.url ?? "/"];
    if (!current) { response.writeHead(404, { "content-type": "text/html" }); response.end("<h1>Missing</h1>"); return; }
    response.writeHead(current.status ?? 200, { "content-type": current.type });
    response.end(current.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const base = "http://127.0.0.1:" + address.port;
  pages["/sitemap.xml"] = { type: "application/xml", body: "<sitemapindex><sitemap><loc>" + base + "/nested.xml</loc></sitemap></sitemapindex>" };
  pages["/nested.xml"] = { type: "application/xml", body: "<urlset><url><loc>" + base + "/</loc></url><url><loc>" + base + "/products/feeder</loc></url><url><loc>" + base + "/category/feeders</loc></url><url><loc>" + base + "/blog/story</loc><lastmod>2026-10-20</lastmod></url><url><loc>" + base + "/blog/gone</loc></url></urlset>" };
  pages["/"] = { type: "text/html", body: "<html><head><title>Home test title for SEO</title><meta name=\"description\" content=\"A useful homepage description for backyard bird lovers.\"></head><body><header><nav><a href=\"/nav-only\">Navigation</a></nav></header><main><h1>Home</h1><p>Welcome to our shop.</p><a href=\"/products/feeder?utm_source=home\">Feeder</a><a href=\"/category/feeders\">Feeders</a><a href=\"/blog/story\">Story</a></main><footer><a href=\"/footer-only\">Footer</a></footer></body></html>" };
  pages["/products/feeder"] = { type: "text/html", body: "<html><head><title>Feeder product page</title><meta name=\"description\" content=\"A great feeder.\"><script type=\"application/ld+json\">{\"@type\":\"Product\",\"name\":\"Feeder\",\"aggregateRating\":{\"ratingValue\":4.5,\"reviewCount\":12}}</script></head><body><main><h1>Feeder</h1><p>Free shipping on this feeder.</p><img src=\"/feeder.jpg\" alt=\"Feeder\"></main></body></html>" };
  pages["/category/feeders"] = { type: "text/html", body: "<html><head><title>Feeders category</title><meta name=\"description\" content=\"Browse all of our bird feeders.\"></head><body><main><h1>Bird Feeders</h1><p>Bird feeders for every yard and every season.</p></main></body></html>" };
  pages["/blog/story"] = { type: "text/html", body: "<html><head><title>Bird care story</title><meta name=\"description\" content=\"Read our guide to feeding backyard birds.\"><meta property=\"article:published_time\" content=\"2026-05-09T10:00:00Z\"><meta property=\"article:section\" content=\"Guides\"><script type=\"application/ld+json\">{\"@type\":\"BlogPosting\",\"author\":{\"name\":\"Ada\"},\"dateModified\":\"2026-06-01\"}</script></head><body><main><article><h1>Bird care story</h1><time datetime=\"2026-04-01\">April</time><p>Useful guide text.</p><a href=\"/products/feeder\">our feeder</a></article></main></body></html>" };
  return base;
}
async function wwwFixtureServer(): Promise<string> {
  const www = path.join(process.cwd(), "fixtures/www");
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    try {
      const source = await readFile(path.join(www, relative), "utf8");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      const base = "http://127.0.0.1:" + address.port;
      const body = source.replaceAll("http://127.0.0.1:8765", base);
      response.writeHead(200, { "content-type": relative.endsWith(".xml") ? "application/xml" : "text/html" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<h1>Not found</h1>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return "http://127.0.0.1:" + address.port;
}

function sku(url: string): SkuRecord {
  return { sku: "F-1", product_id: "P-1", handle: "feeder", title: "Feeder", variant_title: null, url,
    category: "feeders", categories: ["feeders"], category_source: "feed", price: 10, compare_at_price: null,
    currency: "USD", image_url: null, status: "active", first_seen: "2026-10-01", last_seen: "2026-10-22", updated_at: "2026-10-22" };
}

describe("weekly sync", () => {
  it("expands sitemaps and writes SEO, links, blog, product details and categories", async () => {
    const base = await fixtureServer();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-"));
    roots.push(root);
    for (const relative of [PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex, PATHS.productDetails, PATHS.skus, PATHS.categories]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    }
    await writeJsonl(path.join(root, PATHS.skus), [sku(base + "/products/feeder") as unknown as Record<string, unknown>], "sku");
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config = { ...source, base_url: base, sitemaps: [base + "/sitemap.xml"],
      crawl: { ...source.crawl, rate_limit_ms: 0, max_pages: 20 },
      categories: { mode: "url_rule", url_pattern: "/category/" } } as SiteConfig;
    const result = await runWeekly(root, config, { date: "2026-10-22" });
    expect(result.status).toBe("ok");
    const pages = await readJsonl(path.join(root, PATHS.seoPages));
    expect(pages.find((row) => row.url === base + "/products/feeder")).toMatchObject({ page_type: "product", schema_types: ["Product"] });
    const links = await readJsonl(path.join(root, PATHS.seoLinks));
    expect(links.some((row) => String(row.to).includes("nav-only") || String(row.to).includes("footer-only"))).toBe(false);
    expect(links.find((row) => row.to === base + "/products/feeder")?.to_type).toBe("product");
    const blog = await readJsonl(path.join(root, PATHS.blogIndex));
    expect(blog).toHaveLength(1);
    expect(blog[0]).toMatchObject({ published_at: "2026-05-09", updated_at: "2026-06-01", author: "Ada", category: "Guides" });
    const details = await readJsonl(path.join(root, PATHS.productDetails));
    expect(details[0]).toMatchObject({ handle: "feeder", rating: 4.5, review_count: 12, shipping_note: expect.stringContaining("Free shipping") });
    const categories = JSON.parse(await readFile(path.join(root, PATHS.categories), "utf8")) as Array<Record<string, unknown>>;
    expect(categories).toContainEqual(expect.objectContaining({ slug: "feeders", source: "url_rule", name: "Bird Feeders" }));
  }, 30_000);

  it("matches the legacy fixture page and blog fields while emitting the 1.1 tables", async () => {
    const base = await wwwFixtureServer();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-www-"));
    roots.push(root);
    const expectedProject = path.join(process.cwd(), "fixtures/expected/project");
    for (const relative of [PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex, PATHS.productDetails, PATHS.skus, PATHS.categories]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    }
    const skus = (await readJsonl(path.join(expectedProject, PATHS.skus))).map((row) => ({
      ...row, url: String(row.url).replaceAll("http://127.0.0.1:8765", base),
    }));
    await writeJsonl(path.join(root, PATHS.skus), skus, "sku");
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config = { ...source, base_url: base, sitemaps: [base + "/sitemap.xml"],
      crawl: { ...source.crawl, rate_limit_ms: 0, max_pages: 30 },
      categories: { mode: "feed" } } as SiteConfig;
    const result = await runWeekly(root, config, { date: "2026-10-21" });
    expect(result.errors).toEqual([]);
    expect(result.status).toBe("ok");
    const expectedPages = await readJsonl(path.join(expectedProject, "index/catalog/pages.jsonl"));
    const pages = await readJsonl(path.join(root, PATHS.seoPages));
    for (const legacy of expectedPages) {
      const page = pages.find((row) => row.url === String(legacy.url).replace("http://127.0.0.1:8765", base));
      expect(page).toMatchObject({
        page_type: legacy.type, title: legacy.title, meta_description: legacy.meta_description, h1: legacy.h1,
        canonical: String(legacy.canonical).replace("http://127.0.0.1:8765", base), status_code: legacy.status_code,
        indexable: legacy.indexable, word_count: legacy.word_count, last_crawled: "2026-10-21",
      });
    }
    const expectedBlog = await readJsonl(path.join(expectedProject, PATHS.blogIndex));
    const blog = await readJsonl(path.join(root, PATHS.blogIndex));
    for (const legacy of expectedBlog) {
      const legacyInternal = (legacy.links_internal as string[] | undefined)?.map((url) => url.replaceAll("http://127.0.0.1:8765", base));
      expect(blog.find((row) => row.url === String(legacy.url).replace("http://127.0.0.1:8765", base))).toMatchObject({
        slug: legacy.slug, title: legacy.title, published_at: legacy.published_at, updated_at: legacy.updated_at,
        author: legacy.author, tags: legacy.tags, links_internal: legacyInternal, links_products: legacy.links_products,
      });
    }
    expect(blog.some((row) => String(row.url).endsWith("/blog/missing-post"))).toBe(false);
    expect(pages.length).toBeGreaterThan(expectedPages.length);
    expect(await readJsonl(path.join(root, PATHS.seoIssues))).not.toHaveLength(0);
    expect(await readJsonl(path.join(root, PATHS.seoLinks))).not.toHaveLength(0);
  }, 20_000);

  it("keeps the existing output when no sitemap URLs are available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-empty-"));
    roots.push(root);
    await mkdir(path.join(root, path.dirname(PATHS.seoPages)), { recursive: true });
    await writeFile(path.join(root, PATHS.seoPages), "keep this data\n");
    const config = { schema_version: "1.1", domain: "example.com", base_url: "https://example.com", platform: "other",
      currency: "USD", locale: "en-US", timezone: "UTC", brand: { name: "test" }, sitemaps: [],
      crawl: { adapter: "gmc_feed", feed_url: "unused", rate_limit_ms: 0 }, categories: { mode: "feed" },
      workspace_folders: [], schedule: { daily: {}, validate: {}, weekly: {}, readme: {}, monthly: {}, options: {} } } as unknown as SiteConfig;
    const result = await runWeekly(root, config, { date: "2026-10-22" });
    expect(result.status).toBe("failed");
    expect(await readFile(path.join(root, PATHS.seoPages), "utf8")).toBe("keep this data\n");
  });

  it("runs weekly and validate through the unified job service", async () => {
    const base = await fixtureServer();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-job-weekly-"));
    roots.push(root);
    const project = path.join(root, "project");
    await mkdir(path.join(project, path.dirname(PATHS.site)), { recursive: true });
    await mkdir(path.join(project, path.dirname(PATHS.skus)), { recursive: true });
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config = { ...source, base_url: base, sitemaps: [base + "/sitemap.xml"],
      crawl: { ...source.crawl, rate_limit_ms: 0 }, categories: { mode: "url_rule", url_pattern: "/category/" },
      schedule: { options: { validate_after_sync: false } } };
    await writeFile(path.join(project, PATHS.site), JSON.stringify(config));
    await writeJsonl(path.join(project, PATHS.skus), [sku(base + "/products/feeder") as unknown as Record<string, unknown>], "sku");
    const api = createCoreService({ resolveProject: () => project, deviceId: "weekly-test", cacheDir: path.join(root, "cache") });
    const weekly = await api.runJob({ projectPath: project, job: "weekly", trigger: "manual", date: "2026-10-22" }, () => undefined);
    expect(weekly).toMatchObject({ job: "weekly", status: "ok", exitCode: 0 });
    const validation = await api.runJob({ projectPath: project, job: "validate", trigger: "manual", date: "2026-10-22" }, () => undefined);
    expect(validation).toMatchObject({ job: "validate", status: "failed", exitCode: 1 });
    expect(await readFile(path.join(project, PATHS.validation), "utf8")).toContain('"trigger": "manual"');
  }, 20_000);
});
