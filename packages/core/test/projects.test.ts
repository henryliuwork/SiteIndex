import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INIT_STEPS, PATHS, type CreateProjectInput, type DetectResult, type JobProgress, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../src/service";
import { createProjectFiles } from "../src/projects/create";
import { readJsonl } from "../src/io/jsonl";

const FEED_PATH = path.resolve(process.cwd(), "fixtures/feeds/day1.xml");
const TEMP_DIRS: string[] = [];

function mockWebsite(initPages = false): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/") {
      return new Response(`<!doctype html><html lang="en-CA"><head>
        <meta property="og:price:currency" content="CAD">
        <link rel="alternate" type="application/rss+xml" href="/products.xml">
        <script src="https://cdn.shopify.com/store.js"></script>
      </head></html>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n", { status: 200 });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response(`<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>`, { status: 200 });
    }
    if (url.pathname === "/child.xml") {
      const paths = initPages ? ["/", "/products/feeder", "/blog/story", "/category/feeders"] : ["/a", "/b"];
      return new Response(`<urlset>${paths.map((item) => `<url><loc>https://example.com${item}</loc></url>`).join("")}</urlset>`, { status: 200 });
    }
    if (url.pathname === "/feed.html") return new Response("<!doctype html><html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (initPages && ["/products/feeder", "/blog/story", "/category/feeders"].includes(url.pathname)) {
      const tag = url.pathname === "/blog/story" ? "article" : "section";
      const links = '<a href="/products/feeder">Feeder</a><a href="/blog/story">Story</a>';
      return new Response(`<html><head><title>Test ${url.pathname}</title><meta name="description" content="A test page description."></head><body><main><${tag}><h1>Test page</h1><p>Useful content for this page.</p>${links}</${tag}></main></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  }));
}

function makeService() {
  return createCoreService({
    resolveProject: () => "",
    deviceId: "test-device",
    deviceName: "Test Device",
    cacheDir: path.join(os.tmpdir(), "siteindex-test-cache"),
  });
}

function createInput(projectsRoot: string): CreateProjectInput {
  return {
    url: "https://example.com",
    feed_urls: [FEED_PATH],
    sku_field: "id",
    category_depth: 2,
    missing_as: "out_of_stock",
    brand: { name: "Example Shop", tagline: "Useful goods", audience: "Shoppers" },
    markets: ["CA"],
    projects_root: projectsRoot,
    folder_name: "example-shop",
    workspace_folders: ["seo", "产品", "custom"],
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project service", () => {
  it.skipIf(process.platform !== "win32")("creates exactly projects_root\\folder_name on Windows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-win-project-root-"));
    TEMP_DIRS.push(root);
    const detected: DetectResult = {
      input: "https://example.com",
      final_url: "https://example.com/",
      redirect_status: null,
      robots: { found: true, disallow_count: 0, sitemaps: ["https://example.com/sitemap.xml"] },
      sitemaps: [],
      total_urls: 0,
      platform: "other",
      platform_evidence: "test",
      frontend: null,
      locale: null,
      currency: null,
      feed_candidates: [],
    };

    const created = await createProjectFiles({ ...createInput(root), folder_name: "kingsyard" }, detected);

    expect(created.path).toBe(path.resolve(root, "kingsyard"));
    expect(await readdir(root)).toEqual(["kingsyard"]);
    expect(await readdir(created.path)).toContain(PATHS.index.split(path.sep)[0] ?? "index");
    expect(await readdir(created.path)).not.toContain("siteindex");
  });

  it("detects platform, locale, currency, robots and nested sitemaps", async () => {
    mockWebsite();
    const result = await makeService().projects.detect("example.com");

    expect(result).toMatchObject({
      final_url: "https://example.com/",
      platform: "shopify",
      locale: "en-CA",
      currency: "CAD",
      robots: { found: true, disallow_count: 1 },
      total_urls: 2,
      feed_candidates: ["https://example.com/products.xml"],
    });
    expect(result.sitemaps).toEqual([
      { url: "https://example.com/sitemap.xml", type: "index", url_count: 1 },
      { url: "https://example.com/child.xml", type: "urlset", url_count: 2 },
    ]);
  });

  it("inspects feed coverage, skipped rows, stock and category counts", async () => {
    const result = await makeService().projects.inspectFeed([FEED_PATH], { sku_field: "id", category_depth: 2 });

    expect(result.items).toBeGreaterThan(0);
    expect(result.usable_skus).toBeGreaterThan(0);
    expect(result.products).toBeGreaterThan(0);
    expect(result.skipped.duplicate + result.skipped.missing_price_or_link + result.skipped.no_id).toBeGreaterThan(0);
    expect(Object.keys(result.stock).sort()).toEqual(["in_stock", "out_of_stock", "preorder", "unknown"]);
    expect(result.field_coverage.find((field) => field.field === "price")?.pct).toBeGreaterThan(0);
    expect(result.samples.length).toBeGreaterThan(0);
  });

  it("creates files immediately, then completes the init job with progress for every step", async () => {
    mockWebsite(true);
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-create-"));
    TEMP_DIRS.push(root);
    const feedPath = path.join(root, "feed.xml");
    await writeFile(feedPath, '<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>F-1</g:id><g:title>Feeder</g:title><g:link>https://example.com/products/feeder</g:link><g:price>10 USD</g:price><g:availability>in stock</g:availability><g:product_type>Feeders</g:product_type></item></channel></rss>');
    const result = await makeService().projects.create({ ...createInput(root), feed_urls: [feedPath] });
    const projectPath = path.join(root, "example-shop");
    const config = JSON.parse(await readFile(path.join(projectPath, PATHS.site), "utf8")) as {
      domain: string; platform: string; currency: string; workspace_folders?: unknown;
    };

    expect(result).toEqual({ id: "example-shop", runId: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-init$/) });
    expect(config).toMatchObject({ domain: "example.com", platform: "shopify", currency: "CAD" });
    expect(config).not.toHaveProperty("workspace_folders");
    expect(await readJsonl(path.join(projectPath, PATHS.skus))).toEqual([]);
    expect(await readJsonl(path.join(projectPath, PATHS.runs))).toEqual([]);
    const manifest = JSON.parse(await readFile(path.join(projectPath, PATHS.skillsManifest), "utf8")) as { skills: { name: string }[] };
    expect(manifest.skills.length).toBeGreaterThan(0);
    expect(await readFile(path.join(projectPath, PATHS.skillsDir, manifest.skills[0]!.name, "SKILL.md"), "utf8")).toContain("version:");
    expect(await readdir(projectPath)).not.toContain("seo");
    expect(await readdir(projectPath)).not.toContain("产品");
    expect(await readdir(projectPath)).not.toContain("custom");
    expect(await readdir(projectPath)).not.toContain(PATHS.aboutFile);
    expect(await readFile(path.join(projectPath, PATHS.readme), "utf8")).not.toContain('id="folder-map"');
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
    site.crawl.rate_limit_ms = 200;
    await writeFile(sitePath, JSON.stringify(site, null, 2) + "\n");
    const progress: Pick<JobProgress, "step" | "pct">[] = [];
    const init = await makeService().runJob({ projectPath, job: "init", trigger: "manual", date: "2026-10-22" }, (event) => progress.push(event));
    expect(init.status, JSON.stringify(init.steps)).toBe("ok");
    expect(init.steps?.map((step) => step.key)).toEqual([...INIT_STEPS]);
    expect(init.steps?.filter((step) => step.status === "failed")).toEqual([]);
    expect(init.steps?.at(-1)).toMatchObject({ key: "schedule", status: "skipped" });
    expect(progress.every((event) => !event.step || INIT_STEPS.includes(event.step as typeof INIT_STEPS[number]))).toBe(true);
    expect((await readJsonl(path.join(projectPath, PATHS.skus))).length).toBeGreaterThan(0);
    expect((await readJsonl(path.join(projectPath, PATHS.productsView))).length).toBeGreaterThan(0);
    expect((await readJsonl(path.join(projectPath, PATHS.runs))).map((row) => row.job)).toContain("init");
  }, 60_000);

  it("continues weekly when the feed is a webpage and reports a Chinese daily failure", async () => {
    mockWebsite(true);
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-init-html-feed-"));
    TEMP_DIRS.push(root);
    await makeService().projects.create({ ...createInput(root), feed_urls: ["https://example.com/feed.html"] });
    const projectPath = path.join(root, "example-shop");
    const sitePath = path.join(projectPath, PATHS.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
    site.crawl.rate_limit_ms = 200;
    site.categories = { mode: "url_rule", url_pattern: "/category/" };
    await writeFile(sitePath, JSON.stringify(site, null, 2) + "\n");
    const result = await makeService().runJob({ projectPath, job: "init", trigger: "manual", date: "2026-10-22" }, () => undefined);
    expect(result.status).toBe("partial");
    expect(result.steps?.find((step) => step.key === "daily")).toMatchObject({ status: "failed", message: expect.stringContaining("网页而不是商品 feed") });
    expect(result.steps?.find((step) => step.key === "weekly")?.status, JSON.stringify(result.steps)).toBe("ok");
    expect((await readJsonl(path.join(projectPath, PATHS.seoPages))).length).toBeGreaterThan(0);
    expect(result.errors?.join(" ")).toContain("网页而不是商品 feed");
  }, 60_000);

  it("preserves existing user folders, _about.md and README in the chosen project directory", async () => {
    mockWebsite();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-existing-workspace-"));
    TEMP_DIRS.push(root);
    const projectPath = path.join(root, "example-shop");
    await mkdir(path.join(projectPath, "custom"), { recursive: true });
    await writeFile(path.join(projectPath, PATHS.aboutFile), "根目录旧说明\n");
    await writeFile(path.join(projectPath, "custom", PATHS.aboutFile), "自定义目录旧说明\n");
    const originalReadme = '# 用户 README\n\n<!-- siteindex:auto:start id="folder-map" -->\n旧内容\n<!-- siteindex:auto:end id="folder-map" -->\n';
    await writeFile(path.join(projectPath, PATHS.readme), originalReadme);

    await makeService().projects.create(createInput(root));
    expect(await readFile(path.join(projectPath, PATHS.aboutFile), "utf8")).toBe("根目录旧说明\n");
    expect(await readFile(path.join(projectPath, "custom", PATHS.aboutFile), "utf8")).toBe("自定义目录旧说明\n");
    expect(await readFile(path.join(projectPath, PATHS.readme), "utf8")).toBe(originalReadme);
  }, 60_000);
});
