import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXIT, PATHS, type SeoPage, type SiteConfig } from "@siteindex/shared";
import { createCoreService } from "../src/service";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../src/browser/automation";
import { runDesign } from "../src/jobs/design";
import { runIndexCheck } from "../src/jobs/index-check";

const TEMP_ROOTS: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-browser-jobs-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(TEMP_ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeSession(options: {
  onGoto?: (url: string, count: number) => void;
  captchaAt?: number;
  hrefs?: string[][];
  evaluateValues?: unknown[];
} = {}) {
  const visits: string[] = [];
  const viewports: number[] = [];
  const screenshots: string[] = [];
  let evaluateCount = 0;
  const page: BrowserPage = {
    goto: vi.fn(async (url) => {
      visits.push(url);
      options.onGoto?.(url, visits.length);
    }),
    setViewportSize: vi.fn(async ({ width }) => { viewports.push(width); }),
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      screenshots.push(screenshotPath);
      await writeFile(screenshotPath, Buffer.from("fake-png"));
      return Buffer.from("fake-png");
    }),
    evaluate: async <T>() => {
      const value = options.evaluateValues?.[evaluateCount] ?? options.hrefs?.[evaluateCount] ?? [];
      evaluateCount += 1;
      return value as T;
    },
    locator: (selector) => ({
      innerText: async () => "Search results",
      count: async () => selector.includes("recaptcha") && visits.length === options.captchaAt ? 1 : 0,
    }),
    close: vi.fn(async () => undefined),
  };
  const browser: BrowserSession = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return { browser, page, visits, viewports, screenshots };
}

describe("core browser jobs", () => {
  it("extracts design tokens and captures home, category and product pages at both widths", async () => {
    const projectPath = await tempProject();
    const sample = {
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
      logo: "https://store.test/logo.svg",
      favicon: "https://store.test/favicon.ico",
    };
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    await mkdir(path.dirname(path.join(projectPath, PATHS.categories)), { recursive: true });
    await mkdir(path.dirname(path.join(projectPath, PATHS.productsView)), { recursive: true });
    await writeFile(path.join(projectPath, PATHS.categories), JSON.stringify([{ slug: "feeders", url: "https://store.test/collections/feeders" }]), "utf8");
    await writeFile(path.join(projectPath, PATHS.productsView), JSON.stringify({ handle: "feeder", url: "https://store.test/products/feeder" }) + "\n", "utf8");
    const session = fakeSession({ evaluateValues: [sample, sample, sample] });
    const launchBrowser: BrowserLauncher = vi.fn(async () => session.browser);
    const config = { domain: "store.test", base_url: "https://store.test", brand: { name: "Example Store" } } as SiteConfig;

    const result = await runDesign({
      projectPath,
      config,
      executablePath: "C:/Browser/chrome.exe",
      launchBrowser,
      extractedAt: "2026-10-26T00:00:00.000Z",
    });

    expect(launchBrowser).toHaveBeenCalledWith("C:/Browser/chrome.exe", { headless: true });
    expect(session.visits).toEqual([
      "https://store.test",
      "https://store.test/collections/feeders",
      "https://store.test/products/feeder",
    ]);
    expect(session.viewports).toEqual([1440, 390, 1440, 390, 1440, 390]);
    expect(result).toMatchObject({ targets: 3, screenshots: 6, tokens: { source_pages: session.visits, color: { primary: "#176b55" } } });
    expect(JSON.parse(await readFile(path.join(projectPath, PATHS.designTokens), "utf8"))).toMatchObject({
      extracted_at: "2026-10-26T00:00:00.000Z",
      assets: { logo: "https://store.test/logo.svg" },
    });
    expect(await readFile(path.join(projectPath, PATHS.designBrand), "utf8")).toContain("Example Store 品牌视觉规范");
    for (const name of ["home-1440.png", "home-390.png", "category-1440.png", "category-390.png", "product-1440.png", "product-390.png"]) {
      await expect(readFile(path.join(projectPath, PATHS.designScreenshots, name), "utf8")).resolves.toBe("fake-png");
    }
  });

  it("checks no more than 50 URLs with random 20–40 second delays and leaves overflow unchecked", async () => {
    const projectPath = await tempProject();
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    const pages = Array.from({ length: 51 }, (_, index) => ({ url: `https://store.test/page-${index}`, page_type: "page" })) as SeoPage[];
    const session = fakeSession();
    const waits: number[] = [];
    const launchBrowser: BrowserLauncher = vi.fn(async () => session.browser);
    const result = await runIndexCheck({
      projectPath,
      pages,
      executablePath: "/usr/bin/chromium",
      launchBrowser,
      checkedAt: "2026-10-26",
      random: () => 0.5,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });

    expect(result).toEqual({ checked: 50, indexed: 0, not_indexed: 50, unchecked: 1, captcha: false });
    expect(launchBrowser).toHaveBeenCalledWith("/usr/bin/chromium", { headless: false, persistent: true });
    expect(waits).toHaveLength(49);
    expect(waits.every((milliseconds) => milliseconds >= 20_000 && milliseconds <= 40_000)).toBe(true);
    const saved = (await readFile(path.join(projectPath, PATHS.seoPages), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SeoPage);
    expect(saved.filter((page) => page.google_indexed === false && page.index_checked_at === "2026-10-26")).toHaveLength(50);
    expect(saved.find((page) => page.url.endsWith("page-50"))).not.toHaveProperty("index_checked_at");
  });

  it("stops on a CAPTCHA and leaves the challenged and later URLs untouched", async () => {
    const projectPath = await tempProject();
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    const pages = ["one", "two", "three"].map((part) => ({ url: `https://store.test/${part}`, page_type: "page" })) as SeoPage[];
    const session = fakeSession({ captchaAt: 2, hrefs: [["https://store.test/one"]] });
    const waits: number[] = [];
    const result = await runIndexCheck({
      projectPath,
      pages,
      executablePath: "/usr/bin/chromium",
      launchBrowser: async () => session.browser,
      checkedAt: "2026-10-26",
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });

    expect(result).toMatchObject({ checked: 1, indexed: 1, not_indexed: 0, unchecked: 2, captcha: true });
    expect(waits).toHaveLength(1);
    const saved = (await readFile(path.join(projectPath, PATHS.seoPages), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SeoPage);
    expect(saved.find((page) => page.url.endsWith("one"))).toMatchObject({ google_indexed: true, index_checked_at: "2026-10-26" });
    expect(saved.find((page) => page.url.endsWith("two"))).not.toHaveProperty("google_indexed");
    expect(saved.find((page) => page.url.endsWith("three"))).not.toHaveProperty("google_indexed");
  });

  it("returns EXIT 7 for design and index-check when the caller supplies no browser path", async () => {
    const projectPath = await tempProject();
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    await writeFile(path.join(projectPath, PATHS.site), JSON.stringify({ domain: "store.test", base_url: "https://store.test", timezone: "UTC" }), "utf8");
    const service = createCoreService({ resolveProject: () => projectPath, deviceId: "test-device", cacheDir: path.join(projectPath, "cache") });

    for (const job of ["design", "index-check"] as const) {
      const result = await service.runJob({ projectPath, job, trigger: "cli" }, () => undefined);
      expect(result.exitCode).toBe(EXIT.BROWSER_UNAVAILABLE);
      expect(result.status).toBe("failed");
    }
  });
});
