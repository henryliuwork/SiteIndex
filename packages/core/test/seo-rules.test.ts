import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonl, writeJsonl } from "../src/io/jsonl";
import { runWeekly } from "../src/jobs/weekly";
import { validateProjectFiles } from "../src/validate";

interface RepeatText {
  text: string;
  count: number;
}

type FixtureText = string | RepeatText | null;

interface SeoRuleFixturePage {
  path: string;
  status?: number;
  title?: FixtureText;
  title_repeat?: RepeatText;
  description?: FixtureText;
  description_repeat?: RepeatText;
  canonical?: "self" | "other" | "missing";
  headings?: string[];
  robots?: string;
  image_alt?: (string | null)[];
  hreflang?: { language: string; href: string }[];
  links?: string[];
  schema?: Record<string, unknown>[];
  body?: string;
}

interface SeoRuleFixture {
  long_url_segments: number;
  long_url_token: string;
  sitemap_paths: string[];
  redirects: { path: string; to: string }[];
  pages: SeoRuleFixturePage[];
}

const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expandedPath(pathValue: string, fixture: SeoRuleFixture): string {
  return pathValue === fixture.long_url_token ? "/pages/" + "x".repeat(fixture.long_url_segments) : pathValue;
}

function fixtureText(value: FixtureText | undefined): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return value.text.repeat(value.count);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderPage(page: SeoRuleFixturePage, pagePath: string, baseUrl: string): string {
  const title = fixtureText(page.title ?? page.title_repeat);
  const description = fixtureText(page.description ?? page.description_repeat);
  const head = ["<html><head>"];
  if (title !== null) head.push("<title>", escapeHtml(title), "</title>");
  if (description !== null) head.push('<meta name="description" content="', escapeHtml(description), '">');
  if (page.robots) head.push('<meta name="robots" content="', escapeHtml(page.robots), '">');
  if (page.canonical === "self") head.push('<link rel="canonical" href="', baseUrl, pagePath, '">');
  if (page.canonical === "other") head.push('<link rel="canonical" href="', baseUrl, '/canonical-target">');
  for (const alternate of page.hreflang ?? []) {
    head.push('<link rel="alternate" hreflang="', escapeHtml(alternate.language), '" href="', escapeHtml(alternate.href), '">');
  }
  if (page.schema?.length) {
    head.push('<script type="application/ld+json">', JSON.stringify(page.schema), "</script>");
  }
  const body = ["</head><body><main>"];
  for (const heading of page.headings ?? []) body.push("<h1>", escapeHtml(heading), "</h1>");
  if (page.body) body.push("<p>", escapeHtml(page.body), "</p>");
  for (const [index, alt] of (page.image_alt ?? []).entries()) {
    body.push('<img src="/fixture-image-', String(index), '.jpg"');
    if (alt !== null) body.push(' alt="', escapeHtml(alt), '"');
    body.push(">");
  }
  for (const link of page.links ?? []) body.push('<a href="', escapeHtml(link), '">fixture link</a>');
  body.push("</main></body></html>");
  return head.join("") + body.join("");
}

async function seoRuleFixtureServer(): Promise<string> {
  const fixture = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/seo-rules.json"), "utf8")) as SeoRuleFixture;
  const pages = new Map(fixture.pages.map((page) => [expandedPath(page.path, fixture), page]));
  let baseUrl = "";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", baseUrl || "http://localhost").pathname;
    if (pathname === "/seo-rules-sitemap.xml") {
      const urls = fixture.sitemap_paths.map((item) => "<url><loc>" + baseUrl + expandedPath(item, fixture) + "</loc></url>").join("");
      response.writeHead(200, { "content-type": "application/xml" });
      response.end("<urlset>" + urls + "</urlset>");
      return;
    }
    const redirect = fixture.redirects.find((item) => item.path === pathname);
    if (redirect) {
      response.writeHead(302, { location: redirect.to });
      response.end();
      return;
    }
    const page = pages.get(pathname);
    if (!page) {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<title>Not found</title>");
      return;
    }
    response.writeHead(page.status ?? 200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderPage(page, pathname, baseUrl));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  baseUrl = "http://127.0.0.1:" + address.port;
  return baseUrl;
}

describe("weekly SEO rule fixture", () => {
  it("emits existing and expanded rules from deterministic fictional pages", async () => {
    const baseUrl = await seoRuleFixtureServer();
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-seo-rules-"));
    temporaryRoots.push(root);
    for (const relative of [
      PATHS.seoPages, PATHS.seoIssues, PATHS.seoLinks, PATHS.blogIndex,
      PATHS.productDetails, PATHS.skus, PATHS.categories,
    ]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    }
    await writeJsonl(path.join(root, PATHS.skus), [], "sku");
    const source = JSON.parse(await readFile(path.join(process.cwd(), "fixtures/inputs/site.json"), "utf8")) as SiteConfig;
    const config = {
      ...source,
      base_url: baseUrl,
      sitemaps: [baseUrl + "/seo-rules-sitemap.xml"],
      crawl: { ...source.crawl, rate_limit_ms: 0, max_pages: 32 },
      categories: { mode: "manual", manual: [{ slug: "fixture", name: "Fixture", url: baseUrl + "/fixture", match: [] }] },
    } as SiteConfig;

    const result = await runWeekly(root, config, { date: "2026-10-30" });
    expect(result.errors).toEqual([]);
    expect(result.status).toBe("ok");

    const issues = await readJsonl(path.join(root, PATHS.seoIssues));
    const validation = await validateProjectFiles(root, {
      selectedPath: PATHS.seoIssues,
      now: new Date("2026-10-30T12:00:00Z"),
    });
    expect(validation.files.find((file) => file.path === PATHS.seoIssues)).toMatchObject({ status: "ok" });
    const rules = new Set(issues.map((issue) => String(issue.rule)));
    expect([...rules]).toEqual(expect.arrayContaining([
      "http_4xx", "http_5xx", "redirect_chain", "noindex", "canonical_other", "canonical_missing",
      "not_in_sitemap", "title_missing", "title_too_short", "title_too_long", "desc_missing",
      "desc_too_short", "desc_too_long", "title_duplicate", "desc_duplicate", "h1_missing",
      "h1_multiple", "schema_missing", "schema_error", "img_alt_missing", "hreflang_invalid",
      "url_too_long", "thin_content", "orphan",
    ]));
    expect(rules.has("title_length")).toBe(false);
    expect(rules.has("desc_length")).toBe(false);
    const longUrlIssue = issues.find((issue) => issue.rule === "url_too_long");
    if (typeof longUrlIssue?.url !== "string") throw new Error("url_too_long issue is missing");
    expect(longUrlIssue.url.length).toBeGreaterThan(2048);
    expect(issues.find((issue) => issue.rule === "redirect_chain")?.detail).toContain("two hops");
    expect(issues.find((issue) => issue.rule === "hreflang_invalid")?.detail).toContain("Invalid hreflang language");
    expect(issues.find((issue) => issue.rule === "hreflang_invalid")?.detail).toContain("Duplicate hreflang language");
  }, 30_000);
});