import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { EXIT, PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../src/service";
import { repairProjectFile } from "../src/validate";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../src/browser/automation";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];
const SERVERS: Server[] = [];

afterEach(async () => {
  await Promise.all(SERVERS.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeServer(): Promise<{ baseUrl: string; robots: string }> {
  let baseUrl = "";
  const robots = "User-agent: *\nDisallow: /private\nSitemap: {base}/sitemap.xml\n";
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html lang=\"en\"><body><div data-reactroot><h1>Store</h1></div></body></html>");
      return;
    }
    if (request.url === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(robots.replace("{base}", baseUrl));
      return;
    }
    if (request.url === "/sitemap.xml") {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(`<urlset><url><loc>${baseUrl}/</loc></url><url><loc>${baseUrl}/about</loc></url></urlset>`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  SERVERS.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地测试服务器未能监听 TCP 端口。");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, robots: robots.replace("{base}", baseUrl) };
}

function fakeBrowser(): { launcher: BrowserLauncher; visits: string[] } {
  const visits: string[] = [];
  const page: BrowserPage = {
    goto: vi.fn(async (url) => { visits.push(url); }),
    setViewportSize: vi.fn(async () => undefined),
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      await writeFile(screenshotPath, Buffer.from("fake-png"));
      return Buffer.from("fake-png");
    }),
    evaluate: async <T>() => ({
      variables: { "--brand-primary": "#176b55" },
      colors: [{ value: "rgb(23, 107, 85)", count: 4 }],
      text: "rgb(20, 20, 20)",
      background: "rgb(255, 255, 255)",
      font: "Inter, sans-serif",
      headingFont: "Inter, sans-serif",
      scale: { h1: { size: "32px", weight: 700, line_height: "40px" } },
      spacing: ["8px"],
      radius: ["4px"],
      shadow: [],
      components: { button: { background: "#176b55" } },
      logo: null,
      favicon: null,
    }) as T,
    locator: () => ({ innerText: async () => "", count: async () => 0 }),
    close: vi.fn(async () => undefined),
  };
  const browser: BrowserSession = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
  return { launcher: vi.fn(async () => browser), visits };
}

async function projectWithBaseUrl(baseUrl: string): Promise<{ projectPath: string; config: SiteConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-monthly-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  const sitePath = path.join(projectPath, PATHS.site);
  const config = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
  config.base_url = baseUrl;
  config.domain = new URL(baseUrl).hostname;
  config.sitemaps = [`${baseUrl}/sitemap.xml`];
  await writeFile(sitePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { projectPath, config };
}

describe("monthly job", () => {
  it("refreshes site metadata, runs design, and archives the resulting index for restore", async () => {
    const { baseUrl, robots } = await makeServer();
    const { projectPath } = await projectWithBaseUrl(baseUrl);
    const browser = fakeBrowser();
    const service = createCoreService({
      resolveProject: () => projectPath,
      deviceId: "test-device",
      cacheDir: path.join(path.dirname(projectPath), "cache"),
      browserExecutablePath: "C:/Browser/chrome.exe",
      browserLauncher: browser.launcher,
    });
    const progress: { step?: string; pct: number | null }[] = [];

    const result = await service.runJob(
      { projectPath, job: "monthly", trigger: "manual", date: "2026-10-26" },
      (event) => progress.push({ step: event.step, pct: event.pct }),
    );

    expect(result).toMatchObject({
      job: "monthly", status: "ok", exitCode: EXIT.OK,
      counts: { sitemaps: 1, total_urls: 2, design_pages: 1, screenshots: 2, archived_files: expect.any(Number) },
    });
    expect(await readFile(path.join(projectPath, PATHS.robots), "utf8")).toBe(robots);
    expect(JSON.parse(await readFile(path.join(projectPath, PATHS.sitemapsSummary), "utf8"))).toMatchObject({
      sitemaps: [`${baseUrl}/sitemap.xml`], total_urls: 2,
    });
    expect(JSON.parse(await readFile(path.join(projectPath, PATHS.tech), "utf8"))).toEqual({ platform: "other", frontend: "React" });
    expect(browser.visits).toEqual([baseUrl]);
    expect(progress.map((event) => event.step)).toEqual(["metadata", "design", "archive", "done"]);

    const archivedKeywords = path.join(projectPath, PATHS.archiveDir, "2026-10", `${PATHS.keywords}.gz`);
    const keywordsPath = path.join(projectPath, PATHS.keywords);
    const archivedContent = gunzipSync(await readFile(archivedKeywords)).toString("utf8");
    expect(archivedContent).toBe(await readFile(keywordsPath, "utf8"));
    await writeFile(keywordsPath, "damaged\n", "utf8");
    await repairProjectFile(projectPath, PATHS.keywords, "restore_archive", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    expect(await readFile(keywordsPath, "utf8")).toBe(archivedContent);
    await expect(readFile(path.join(projectPath, PATHS.archiveDir, "2026-10", `${PATHS.lock}.gz`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(projectPath, PATHS.archiveDir, "2026-10", `${PATHS.archiveDir}.gz`))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("returns browser unavailable before changing site files or creating an archive", async () => {
    const { baseUrl } = await makeServer();
    const { projectPath } = await projectWithBaseUrl(baseUrl);
    const service = createCoreService({
      resolveProject: () => projectPath,
      deviceId: "test-device",
      cacheDir: path.join(path.dirname(projectPath), "cache"),
    });

    const result = await service.runJob({ projectPath, job: "monthly", trigger: "manual", date: "2026-10-26" }, () => undefined);

    expect(result).toMatchObject({ status: "failed", exitCode: EXIT.BROWSER_UNAVAILABLE });
    await expect(readFile(path.join(projectPath, PATHS.robots))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(projectPath, PATHS.archiveDir, "2026-10"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
