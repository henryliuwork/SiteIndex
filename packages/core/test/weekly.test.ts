import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, pathsFor, type SiteConfig, type SkuRecord } from "@siteindex/shared";
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
async function blogRecognitionFixtureServer(): Promise<string> {
  const pages: Record<string, { type: string; body: string }> = {};
  let base = "";
  const server = createServer((request, response) => {
    const current = pages[new URL(request.url ?? "/", "http://localhost").pathname];
    if (!current) { response.writeHead(404, { "content-type": "text/html" }); response.end("<h1>Not found</h1>"); return; }
    response.writeHead(200, { "content-type": current.type });
    response.end(current.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  base = "http://127.0.0.1:" + address.port;
  pages["/sitemap.xml"] = { type: "application/xml", body: "<urlset><url><loc>" + base + "/editorial/sitemap-story</loc></url><url><loc>" + base + "/guides/pattern-story</loc></url></urlset>" };
  pages["/blog-sitemap.xml"] = { type: "application/xml", body: "<urlset><url><loc>" + base + "/editorial/dedicated-sitemap-story</loc></url></urlset>" };
  for (const route of ["/editorial/sitemap-story", "/guides/pattern-story", "/editorial/dedicated-sitemap-story"]) {
    pages[route] = { type: "text/html", body: "<html><head><title>Sample editorial page</title></head><body><main><h1>Sample editorial page</h1><p>Fixture content used to test configured blog recognition.</p></main></body></html>" };
  }
  return base;
}
async function magentoFixtureServer(): Promise<string> {
  const root = path.join(process.cwd(), "fixtures/www");
  const product = await readFile(path.join(root, "magento-product-structure.html"), "utf8");
  const blog = await readFile(path.join(root, "magento-blog-structure.html"), "utf8");
  let base = "";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/sitemap.xml") {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end("<urlset><url><loc>" + base + "/sample-item.html</loc></url><url><loc>" + base + "/news/sample-guide.html</loc></url></urlset>");
      return;
    }
    const source = pathname === "/sample-item.html" ? product : pathname === "/news/sample-guide.html" ? blog : null;
    if (source) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(source);
      return;
    }
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>Missing fixture</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  base = "http://127.0.0.1:" + address.port;
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
  it("keeps the Core blog summary in sync with sitemap and URL-prefix configuration", async () => {
    const base = await blogRecognitionFixtureServer();
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const baseConfig = { ...source, base_url: base, sitemaps: [base + "/sitemap.xml"],
      crawl: { ...source.crawl, blog_url_patterns: [], rate_limit_ms: 0, max_pages: 10 },
      categories: { mode: "manual", manual: [{ slug: "fixture", name: "Fixture", url: base + "/fixture", match: [] }] } } as SiteConfig;
    const scenarios: Array<{ content?: SiteConfig["content"]; expectedPages: number; expectedUrls: string[] }> = [
      { expectedPages: 2, expectedUrls: [] },
      { content: { blog_url_patterns: ["/guides/"] }, expectedPages: 2, expectedUrls: [base + "/guides/pattern-story"] },
      {
        content: { blog_sitemaps: [base + "/blog-sitemap.xml"], blog_url_patterns: ["/guides/"] },
        expectedPages: 3,
        expectedUrls: [base + "/editorial/dedicated-sitemap-story", base + "/guides/pattern-story"],
      },
    ];

    for (const scenario of scenarios) {
      const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-blog-summary-"));
      roots.push(root);
      await mkdir(path.dirname(path.join(root, PATHS.site)), { recursive: true });
      for (const relative of [PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex, PATHS.productDetails, PATHS.skus, PATHS.categories]) {
        await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      }
      await writeJsonl(path.join(root, PATHS.skus), [], "sku");
      await writeJsonl(path.join(root, PATHS.blogIndex), [], "blog_post");
      const config = { ...baseConfig, ...(scenario.content ? { content: scenario.content } : {}) };
      await writeFile(path.join(root, PATHS.site), JSON.stringify(config));
      const api = createCoreService({
        resolveProject: (id) => id === "fixture" ? root : path.join(root, "missing"),
        deviceId: "weekly-blog-summary-test",
        cacheDir: path.join(root, "cache"),
      });

      // Warm the snapshot first so the assertion also exercises the service after weekly writes.
      expect((await api.content.summary("fixture")).kpis.find((item) => item.key === "blogs")?.value).toBe("0");
      const weekly = await api.runJob({ projectPath: root, job: "weekly", trigger: "manual", date: "2026-10-29" }, () => undefined);
      expect(weekly.counts?.pages).toBe(scenario.expectedPages);
      expect(weekly.counts?.blog ?? 0).toBe(scenario.expectedUrls.length);

      const blogRows = await readJsonl(path.join(root, PATHS.blogIndex));
      expect(blogRows.map((row) => row.url)).toEqual(scenario.expectedUrls);
      expect((await api.content.summary("fixture")).kpis.find((item) => item.key === "blogs")?.value).toBe(String(blogRows.length));
    }
  }, 20_000);

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

  it("recognizes Magento product and blog structure without relying on feed product URLs", async () => {
    const base = await magentoFixtureServer();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-magento-"));
    roots.push(root);
    for (const relative of [PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex, PATHS.productDetails, PATHS.skus, PATHS.categories]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    }
    await writeJsonl(path.join(root, PATHS.skus), [], "sku");
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config = { ...source, base_url: base, sitemaps: [base + "/sitemap.xml"],
      crawl: { ...source.crawl, rate_limit_ms: 0, max_pages: 10 },
      categories: { mode: "manual", manual: [{ slug: "sample", name: "Sample", url: base + "/sample" }] } } as SiteConfig;
    const result = await runWeekly(root, config, { date: "2026-10-28" });
    expect(result.status).toBe("ok");
    const pages = await readJsonl(path.join(root, PATHS.seoPages));
    expect(pages.find((row) => row.url === base + "/sample-item.html")).toMatchObject({ page_type: "product" });
    expect(pages.find((row) => row.url === base + "/news/sample-guide.html")).toMatchObject({ page_type: "blog" });
    const details = await readJsonl(path.join(root, PATHS.productDetails));
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      handle: "sample-item", rating: 4.5, review_count: 2,
      breadcrumbs: ["Home", "Outdoor", "Sample item"],
      gallery: [base + "/media/sample-front.jpg", base + "/media/sample-side.jpg"],
    });
    const blog = await readJsonl(path.join(root, PATHS.blogIndex));
    expect(blog).toHaveLength(1);
    expect(blog[0]).toMatchObject({ slug: "sample-guide", title: "Sample garden guide", author: "Sample Editor", published_at: "2026-01-02" });
    const issues = await readJsonl(path.join(root, PATHS.seoIssues));
    expect(issues.some((row) => row.rule === "schema_missing" && [base + "/sample-item.html", base + "/news/sample-guide.html"].includes(String(row.url)))).toBe(false);
  }, 20_000);

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

  it("writes weekly outputs to the workspace layout with fixture-backed content", async () => {
    const base = await wwwFixtureServer();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-workspace-"));
    roots.push(root);
    const paths = pathsFor("workspace");
    const expectedProject = path.join(process.cwd(), "fixtures/expected/project");
    for (const relative of [paths.site, paths.seoPages, paths.seoIssues, paths.seoLinks, paths.blogIndex,
      paths.productDetails, paths.skus, paths.categories]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    }
    const skus = (await readJsonl(path.join(expectedProject, PATHS.skus))).map((row) => ({
      ...row, url: String(row.url).replaceAll("http://127.0.0.1:8765", base),
    }));
    await writeJsonl(path.join(root, paths.skus), skus, "sku");
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config = { ...source, base_url: base, sitemaps: [base + "/sitemap.xml"],
      crawl: { ...source.crawl, rate_limit_ms: 0, max_pages: 30 }, categories: { mode: "feed" } } as SiteConfig;
    await writeFile(path.join(root, paths.site), JSON.stringify(config));

    const result = await runWeekly(root, config, { date: "2026-10-21" });

    expect(result.status).toBe("ok");
    const pages = await readJsonl(path.join(root, paths.seoPages));
    const expectedPages = await readJsonl(path.join(expectedProject, "index/catalog/pages.jsonl"));
    const legacyPage = expectedPages[0]!;
    const page = pages.find((row) => row.url === String(legacyPage.url).replace("http://127.0.0.1:8765", base));
    expect(page).toMatchObject({
      page_type: legacyPage.type, title: legacyPage.title, meta_description: legacyPage.meta_description,
      canonical: String(legacyPage.canonical).replace("http://127.0.0.1:8765", base),
    });
    const expectedBlog = await readJsonl(path.join(expectedProject, PATHS.blogIndex));
    const blogs = await readJsonl(path.join(root, paths.blogIndex));
    for (const legacy of expectedBlog) {
      expect(blogs.some((row) => row.url === String(legacy.url).replace("http://127.0.0.1:8765", base))).toBe(true);
    }
    expect(await readFile(path.join(root, PATHS.seoPages)).catch(() => null)).toBeNull();
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

  it("extracts deep product specs, highlights, FAQs, category price bands, blog excerpts and site/tech.json policies", async () => {
    const pages: Record<string, { type: string; body: string }> = {};
    let base = "";
    const server = createServer((req, res) => {
      const current = pages[new URL(req.url ?? "/", "http://localhost").pathname];
      if (!current) { res.writeHead(404, { "content-type": "text/html" }).end("<h1>Missing</h1>"); return; }
      res.writeHead(200, { "content-type": current.type }).end(current.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server did not bind");
    base = `http://127.0.0.1:${addr.port}`;

    pages["/sitemap.xml"] = {
      type: "application/xml",
      body: `<urlset>
        <url><loc>${base}/</loc></url>
        <url><loc>${base}/products/feeder</loc></url>
        <url><loc>${base}/category/feeders</loc></url>
        <url><loc>${base}/blog/feeding-guide</loc></url>
        <url><loc>${base}/shipping-policy</loc></url>
        <url><loc>${base}/returns-policy</loc></url>
      </urlset>`,
    };
    pages["/"] = {
      type: "text/html",
      body: `<html><head><title>Brand Home</title>
        <script type="application/ld+json">{"@type":"Organization","name":"Brand","email":"support@example.test","sameAs":["https://www.instagram.com/exampletest"]}</script>
      </head><body>
        <header><p>Free standard shipping on orders over $49 across the US.</p></header>
        <main><h1>Welcome</h1><a href="/products/feeder">Feeder</a><a href="/category/feeders">Feeders</a><a href="/blog/feeding-guide">Guide</a></main>
      </body></html>`,
    };
    pages["/products/feeder"] = {
      type: "text/html",
      body: `<html><head><title>Feeder SEO Title</title><meta name="description" content="SEO meta description fallback.">
        <script type="application/ld+json">[
          {"@type":"Product","name":"Feeder","additionalProperty":[{"name":"Capacity","value":"4 lbs"}]},
          {"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is the tray removable?","acceptedAnswer":{"@type":"Answer","text":"Yes, the seed tray lifts out for quick rinsing."}}]}
        ]</script>
      </head><body><main>
        <h1>Cedar Tube Feeder</h1>
        <div class="product-short-description">
          <p>Built from weather-resistant western red cedar for year-round backyard birding.</p>
          <ul>
            <li>Chew-resistant powder-coated metal ports</li>
            <li>Tool-free twist-off lid for easy refilling</li>
          </ul>
        </div>
        <table class="shop_attributes">
          <tr><th>Material</th><td>Western Red Cedar</td></tr>
          <tr><th>Dimensions</th><td>8 x 8 x 16 in</td></tr>
        </table>
        <p>Backed by our 2-year warranty and 30-day money-back guarantee.</p>
      </main></body></html>`,
    };
    pages["/category/feeders"] = {
      type: "text/html",
      body: `<html><head><title>Bird Feeders Collection</title><meta name="description" content="Shop durable bird feeders."></head>
        <body><main><h1>Bird Feeders</h1><p>Explore our handcrafted cedar and metal bird feeders designed to attract cardinals and finches.</p></main></body></html>`,
    };
    pages["/blog/feeding-guide"] = {
      type: "text/html",
      body: `<html><head><title>Winter Feeding Guide</title></head><body><main><article>
        <h1>Winter Feeding Guide</h1>
        <p>Winter bird feeding helps backyard songbirds survive freezing nights when natural seeds are scarce.</p>
        <h2>What seeds attract cardinals in winter?</h2>
        <p>Black oil sunflower seeds are the top choice.</p>
      </article></main></body></html>`,
    };
    pages["/shipping-policy"] = {
      type: "text/html",
      body: `<html><head><title>Shipping Policy</title></head><body><main><h1>Shipping Policy</h1><p>Orders ship within 24 hours with free shipping on orders over $49.</p></main></body></html>`,
    };
    pages["/returns-policy"] = {
      type: "text/html",
      body: `<html><head><title>Returns Policy</title></head><body><main><h1>Returns Policy</h1><p>We offer a 30-day money-back return policy on all unused items.</p></main></body></html>`,
    };

    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-weekly-deep-"));
    roots.push(root);
    for (const relative of [PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex, PATHS.productDetails, PATHS.skus, PATHS.categories]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    }
    await writeJsonl(path.join(root, PATHS.skus), [sku(`${base}/products/feeder`) as unknown as Record<string, unknown>], "sku");
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config: SiteConfig = {
      ...source,
      base_url: base,
      sitemaps: [`${base}/sitemap.xml`],
      policies: { warranty_summary: "2-year replacement warranty" },
      crawl: { ...source.crawl, rate_limit_ms: 0, max_pages: 20 },
      categories: { mode: "url_rule", url_pattern: "/category/" },
    };

    const result = await runWeekly(root, config, { date: "2026-10-22" });
    expect(result.status).toBe("ok");

    const details = await readJsonl(path.join(root, PATHS.productDetails));
    expect(details[0]).toMatchObject({
      handle: "feeder",
      short_description: expect.stringContaining("Built from weather-resistant western red cedar"),
      highlights: [
        "Chew-resistant powder-coated metal ports",
        "Tool-free twist-off lid for easy refilling",
      ],
      specs: {
        Capacity: "4 lbs",
        Dimensions: "8 x 8 x 16 in",
        Material: "Western Red Cedar",
      },
      faqs: [
        { question: "Is the tray removable?", answer: "Yes, the seed tray lifts out for quick rinsing." },
      ],
      warranty_note: expect.stringContaining("2-year warranty"),
    });

    const categories = JSON.parse(await readFile(path.join(root, PATHS.categories), "utf8")) as Array<Record<string, unknown>>;
    expect(categories[0]).toMatchObject({
      slug: "feeders",
      title: "Bird Feeders Collection",
      meta_description: "Shop durable bird feeders.",
      intro_excerpt: expect.stringContaining("Explore our handcrafted cedar and metal bird feeders"),
      price_min: 10,
      price_max: 10,
      top_handles: ["feeder"],
    });

    const blogs = await readJsonl(path.join(root, PATHS.blogIndex));
    expect(blogs[0]).toMatchObject({
      slug: "feeding-guide",
      excerpt: expect.stringContaining("Winter bird feeding helps backyard songbirds"),
      faq_questions: ["What seeds attract cardinals in winter?"],
    });

    const tech = JSON.parse(await readFile(path.join(root, PATHS.tech), "utf8")) as Record<string, unknown>;
    expect(tech).toMatchObject({
      key_pages: {
        shipping: `${base}/shipping-policy`,
        returns: `${base}/returns-policy`,
      },
      policies: {
        free_shipping_threshold: { value: expect.stringContaining("free shipping on orders over $49"), source: "extracted" },
        return_summary: { value: expect.stringContaining("30-day money-back"), source: "extracted" },
        warranty_summary: { value: "2-year replacement warranty", source: "config", source_url: null },
      },
      contact: {
        email: { value: "support@example.test", source: "extracted" },
      },
      social_links: {
        instagram: "https://www.instagram.com/exampletest",
      },
    });
  }, 20_000);
});
