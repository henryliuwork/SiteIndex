import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PATHS, type CreateProjectInput, type DetectResult } from "@siteindex/shared";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../src/browser/automation";
import { createProjectFiles } from "../src/projects/create";
import { createCoreService } from "../src/service";

const roots: string[] = [];
const fixture = path.resolve("fixtures/upgrade-0.8.0");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeBrowser(): BrowserLauncher {
  const page: BrowserPage = {
    goto: async () => undefined,
    setViewportSize: async () => undefined,
    screenshot: async ({ path: output }) => {
      const bytes = Buffer.from("synthetic screenshot");
      await writeFile(output, bytes);
      return bytes;
    },
    evaluate: async <T>() => ({
      variables: {}, colors: [],
      roles: { primary: null, secondary: null, text: null, text_muted: null,
        background: null, surface: null, border: null, sale: null, link: null },
      fonts: { heading: null, body: null, mono: null }, scale: {},
      spacing: [], radius: [], shadow: [],
      buttons: { primary: null, secondary: null, outline: null },
      components: {}, logo: null, favicon: null,
    }) as T,
    locator: () => ({ innerText: async () => "", count: async () => 0 }),
    close: async () => undefined,
  };
  const browser: BrowserSession = { newPage: async () => page, close: async () => undefined };
  return async () => browser;
}

it("preserves v0.8.0 user fields through startup and every scheduled job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-upgrade-080-"));
  roots.push(root);
  const base = "https://synthetic-shop.test";
  const detected: DetectResult = {
    input: base, final_url: `${base}/`, redirect_status: null,
    robots: { found: true, disallow_count: 0, sitemaps: [`${base}/sitemap.xml`] },
    sitemaps: [], total_urls: 0, platform: "other", platform_evidence: "fixture",
    frontend: null, locale: "en-US", currency: "USD", feed_candidates: [],
  };
  const input: CreateProjectInput = {
    url: base, feed_urls: [`${base}/feed.xml`], sku_field: "id", category_depth: 1,
    missing_as: "out_of_stock", brand: { name: "Synthetic Archive" }, markets: ["US"],
    projects_root: root, folder_name: "project", workspace_folders: [],
  };
  const project = (await createProjectFiles(input, detected)).path;
  // The v0.8.0 tag contains these same legacy index rows; current scaffolding fills files absent from that small sample.
  await cp(path.resolve("fixtures/e-v050-w0/projects/legacy/index"), path.join(project, PATHS.index),
    { recursive: true, force: true });
  await cp(path.join(fixture, "site.json"), path.join(project, PATHS.site));
  await cp(path.join(fixture, "project-README.md"), path.join(project, PATHS.readme));
  const originalSite = await readFile(path.join(project, PATHS.site), "utf8");
  const expectedBlocks = {
    overview: "This is a synthetic project.\nThe overview has a second line.",
    focus: "Keep the sample catalog current.",
    rules: "Preserve user-authored text across refreshes.",
  };
  const feed = await readFile(path.join(fixture, "feed.xml"), "utf8");
  vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    const pages: Record<string, [string, string]> = {
      "/feed.xml": ["application/xml", feed],
      "/robots.txt": ["text/plain", `User-agent: *\nSitemap: ${base}/sitemap.xml\n`],
      "/sitemap.xml": ["application/xml", `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/products/demo-a</loc></url><url><loc>${base}/products/demo-b</loc></url><url><loc>${base}/blog/demo-story</loc></url></urlset>`],
      "/": ["text/html", `<html><head><title>Synthetic archive home</title></head><body><main><h1>Home</h1><a href="${base}/products/demo-a">Sample item</a><a href="${base}/blog/demo-story">Story</a></main></body></html>`],
      "/products/demo-a": ["text/html", `<html><head><title>Sample item A</title><script type="application/ld+json">{"@type":"Product","name":"Sample item A"}</script></head><body><main><h1>Sample item A</h1><a href="${base}/products/demo-b">Sample item B</a></main></body></html>`],
      "/products/demo-b": ["text/html", "<html><head><title>Sample item B</title></head><body><main><h1>Sample item B</h1></main></body></html>"],
      "/blog/demo-story": ["text/html", `<html><head><title>Sample story</title><script type="application/ld+json">{"@type":"BlogPosting","headline":"Sample story"}</script></head><body><main><article><h1>Sample story</h1><a href="${base}/products/demo-a">Sample item</a></article></main></body></html>`],
    };
    const page = pages[url.pathname];
    return page ? new Response(page[1], { headers: { "content-type": page[0] } })
      : new Response("missing", { status: 404 });
  }));

  const service = () => createCoreService({ resolveProject: () => project, deviceId: "upgrade-test",
    cacheDir: path.join(root, "cache"), browserExecutablePath: "C:/Synthetic/browser.exe",
    browserLauncher: fakeBrowser() });
  const checkUserFields = async () => {
    expect(await readFile(path.join(project, PATHS.site), "utf8")).toBe(originalSite);
    expect((await service().projects.get("project")).config.seo?.core_keywords).toEqual(["sample product", "long tail phrase"]);
    expect((await service().readme.get("project")).user_blocks).toEqual(expectedBlocks);
  };
  await checkUserFields(); // startup read
  for (const job of ["daily", "weekly", "monthly", "readme", "validate"] as const) {
    const result = await service().runJob({ projectPath: project, job, trigger: "manual", date: "2026-11-23" }, () => undefined);
    expect(result.status, `${job}: ${JSON.stringify(result)}`).toBe("ok");
    await checkUserFields(); // new service after each job
  }
}, 60_000);
