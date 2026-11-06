import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXIT, PATHS, pathsFor, type SeoPage, type SiteConfig } from "@siteindex/shared";
import { createCoreService } from "../src/service";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../src/browser/automation";
import { launchChromium } from "../src/browser/automation";
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
    const scale = Object.fromEntries(["h1", "h2", "h3", "h4", "h5", "h6", "body", "small", "caption"].map((key, index) => [key, {
      size: `${32 - index * 2}px`, weight: index < 2 ? 700 : 400, line_height: `${40 - index * 2}px`, letter_spacing: "0px",
    }]));
    const sample = {
      variables: { "--color-primary": "#176b55", "--color-secondary": "#d18a22", "--color-text": "#141414", "--color-background": "#ffffff" },
      colors: [{ value: "rgb(23, 107, 85)", count: 4 }],
      roles: {
        primary: { value: "#176b55", source: "--color-primary", confidence: 0.98 },
        secondary: { value: "#d18a22", source: "--color-secondary", confidence: 0.98 },
        text: { value: "#141414", source: "--color-text", confidence: 0.98 },
        text_muted: { value: "#777777", source: ".muted", confidence: 0.82 },
        background: { value: "#ffffff", source: "--color-background", confidence: 0.98 },
        surface: { value: "#f5f5f2", source: ".surface", confidence: 0.78 },
        border: { value: "#dddddd", source: "--color-border", confidence: 0.98 },
        sale: { value: "#c02a35", source: "--color-sale", confidence: 0.98 },
        link: { value: "#08765d", source: "--color-link", confidence: 0.98 },
      },
      fonts: { heading: "Lora, serif", body: "Inter, sans-serif", mono: "ui-monospace, monospace" },
      scale,
      spacing: ["8px", "16px", "24px", "4px", "12px", "32px", "48px"].map((value, index) => ({ value, count: 7 - index })),
      radius: ["4px", "8px", "12px", "2px", "16px", "50%", "20px"].map((value, index) => ({ value, count: 7 - index })),
      shadow: ["0 1px 2px #000", "0 2px 4px #000", "0 4px 8px #000", "inset 0 0 1px #000", "0 8px 16px #000", "0 1px 4px #000", "0 10px 20px #000"].map((value, index) => ({ value, count: 7 - index })),
      buttons: {
        primary: { background: "#176b55", text_color: "#ffffff", border: null, border_radius: "4px", padding: "8px 16px", font_size: "14px", font_weight: 700 },
        secondary: { background: "#d18a22", text_color: "#141414", border: "1px solid #d18a22", border_radius: "4px", padding: "8px 16px", font_size: "14px", font_weight: 600 },
        outline: { background: null, text_color: "#176b55", border: "1px solid #176b55", border_radius: "4px", padding: "8px 16px", font_size: "14px", font_weight: 600 },
      },
      components: { button: { background: "#176b55" } },
      logo: "https://design-v2.test/logo.svg",
      favicon: "https://design-v2.test/favicon.ico",
    };
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    await mkdir(path.dirname(path.join(projectPath, PATHS.categories)), { recursive: true });
    await mkdir(path.dirname(path.join(projectPath, PATHS.productsView)), { recursive: true });
    await writeFile(path.join(projectPath, PATHS.categories), JSON.stringify([{ slug: "collection", url: "https://design-v2.test/collection.html" }]), "utf8");
    await writeFile(path.join(projectPath, PATHS.productsView), JSON.stringify({ handle: "product", url: "https://design-v2.test/product.html" }) + "\n", "utf8");
    const session = fakeSession({ evaluateValues: [sample, sample, sample] });
    const launchBrowser: BrowserLauncher = vi.fn(async () => session.browser);
    const config = { domain: "design-v2.test", base_url: "https://design-v2.test", brand: { name: "Example Store" } } as SiteConfig;

    const result = await runDesign({
      projectPath,
      config,
      executablePath: "C:/Browser/chrome.exe",
      launchBrowser,
      extractedAt: "2026-10-26T00:00:00.000Z",
    });

    expect(launchBrowser).toHaveBeenCalledWith("C:/Browser/chrome.exe", { headless: true });
    expect(session.visits).toEqual([
      "https://design-v2.test",
      "https://design-v2.test/collection.html",
      "https://design-v2.test/product.html",
    ]);
    expect(session.viewports).toEqual([1440, 390, 1440, 390, 1440, 390]);
    expect(result).toMatchObject({
      targets: 3,
      screenshots: 6,
      tokens: {
        source_pages: session.visits,
        color: { primary: "#176b55", secondary: "#d18a22", text: "#141414", roles: { link: { source: "--color-link", confidence: 0.98 } } },
        typography: { font_families: { heading: "Lora, serif", body: "Inter, sans-serif", mono: "ui-monospace, monospace" } },
        buttons: { primary: { background: "#176b55" }, secondary: { background: "#d18a22" }, outline: { background: null } },
      },
    });
    expect(Object.keys(result.tokens.typography.scale).sort()).toEqual(["body", "caption", "h1", "h2", "h3", "h4", "h5", "h6", "small"]);
    expect(result.tokens.spacing).toEqual(["8px", "16px", "24px", "4px", "12px", "32px"]);
    expect(result.tokens.radius).toHaveLength(6);
    expect(result.tokens.shadow).toHaveLength(6);
    expect(result.tokens.color.roles?.primary).toEqual({ value: "#176b55", source: "--color-primary", confidence: 0.98 });
    expect(JSON.parse(await readFile(path.join(projectPath, PATHS.designTokens), "utf8"))).toMatchObject({
      extracted_at: "2026-10-26T00:00:00.000Z",
      assets: { logo: "https://design-v2.test/logo.svg" },
    });
    const designSummary = await readFile(path.join(projectPath, PATHS.designBrand), "utf8");
    expect(designSummary).toContain("Example Store 品牌视觉规范");
    expect(designSummary).toContain("## 色彩角色");
    expect(designSummary).toContain("## 字体与字号层级");
    expect(designSummary).toContain("## 按钮规范");
    for (const name of ["home-1440.png", "home-390.png", "category-1440.png", "category-390.png", "product-1440.png", "product-390.png"]) {
      await expect(readFile(path.join(projectPath, PATHS.designScreenshots, name), "utf8")).resolves.toBe("fake-png");
    }
  });

  it("does not infer missing roles from unrelated palette colors", async () => {
    const projectPath = await tempProject();
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    const noRoles = {
      variables: { "--random-accent-number": "12px" },
      colors: [{ value: "rgb(111, 33, 44)", count: 99 }],
      roles: { primary: null, secondary: null, text: null, text_muted: null, background: null, surface: null, border: null, sale: null, link: null },
      fonts: { heading: null, body: null, mono: null },
      scale: {}, spacing: [], radius: [], shadow: [],
      buttons: { primary: null, secondary: null, outline: null },
      components: {}, logo: null, favicon: null,
    };
    const session = fakeSession({ evaluateValues: [noRoles] });
    const result = await runDesign({
      projectPath,
      config: { domain: "design-v2.test", base_url: "https://design-v2.test" } as SiteConfig,
      executablePath: "C:/Browser/chrome.exe",
      launchBrowser: async () => session.browser,
    });

    expect(result.tokens.color.roles).toEqual({ primary: null, secondary: null, text: null, text_muted: null, background: null, surface: null, border: null, sale: null, link: null });
    expect(result.tokens.color.primary).toBeNull();
    expect(result.tokens.color.secondary).toBeNull();
    expect(result.tokens.color.palette[0]?.value).toBe("rgb(111, 33, 44)");
  });

  it.skipIf(!process.env.SITEINDEX_TEST_BROWSER)("extracts role, scale and button tokens from fictional local static pages", async () => {
    const projectPath = await tempProject();
    const fixtureDir = path.resolve(process.cwd(), "fixtures/www/design-v2");
    const files = new Map([["/", "index.html"], ["/collection.html", "collection.html"], ["/product.html", "product.html"], ["/styles.css", "styles.css"]]);
    const server = createServer((request, response) => {
      const filename = files.get(request.url ?? "");
      if (!filename) { response.writeHead(404).end(); return; }
      void readFile(path.join(fixtureDir, filename)).then((content) => {
        response.writeHead(200, { "content-type": filename.endsWith(".css") ? "text/css" : "text/html" });
        response.end(content);
      }).catch(() => { response.writeHead(500).end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Static fixture server did not start");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
      await mkdir(path.dirname(path.join(projectPath, PATHS.categories)), { recursive: true });
      await mkdir(path.dirname(path.join(projectPath, PATHS.productsView)), { recursive: true });
      await writeFile(path.join(projectPath, PATHS.categories), JSON.stringify([{ slug: "collection", url: `${baseUrl}/collection.html` }]), "utf8");
      await writeFile(path.join(projectPath, PATHS.productsView), JSON.stringify({ handle: "product", url: `${baseUrl}/product.html` }) + "\n", "utf8");
      const result = await runDesign({
        projectPath,
        config: { domain: "design-fixture.test", base_url: baseUrl } as SiteConfig,
        executablePath: process.env.SITEINDEX_TEST_BROWSER!,
        launchBrowser: launchChromium,
        extractedAt: "2026-11-06T00:00:00.000Z",
      });
      expect(result.tokens.color.roles?.primary).toMatchObject({ value: "#186b55", source: "--color-primary", confidence: 0.98 });
      expect(result.tokens.color.roles?.sale?.source).toBe("--color-sale");
      expect(result.tokens.typography.scale).toHaveProperty("h6");
      expect(result.tokens.typography.scale).toHaveProperty("caption");
      expect(result.tokens.buttons?.primary?.background).toBe("rgb(24, 107, 85)");
      expect(result.tokens.buttons?.primary?.hover_background).toBe("rgb(18, 91, 72)");
      expect(result.tokens.buttons?.secondary?.background).toBe("rgb(209, 138, 34)");
      expect(result.tokens.buttons?.outline?.border).toContain("solid");
      expect(result.tokens.spacing.length).toBeLessThanOrEqual(6);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

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

  it("writes index-check results under the workspace SEO directory", async () => {
    const projectPath = await tempProject();
    const paths = pathsFor("workspace");
    await mkdir(path.join(projectPath, paths.index), { recursive: true });
    await writeFile(path.join(projectPath, paths.site), JSON.stringify({ domain: "store.test" }), "utf8");
    const session = fakeSession();

    const result = await runIndexCheck({
      projectPath,
      pages: [{ url: "https://store.test/page", page_type: "page" }] as SeoPage[],
      executablePath: "/usr/bin/chromium",
      launchBrowser: async () => session.browser,
      checkedAt: "2026-10-26",
      wait: async () => undefined,
    });

    expect(result.checked).toBe(1);
    const saved = (await readFile(path.join(projectPath, paths.seoPages), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as SeoPage);
    expect(saved[0]).toMatchObject({ url: "https://store.test/page", google_indexed: false, index_checked_at: "2026-10-26" });
    await expect(readFile(path.join(projectPath, PATHS.seoPages))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("maps an invalid caller browser executable to BROWSER_UNAVAILABLE", async () => {
    await expect(launchChromium(path.join(os.tmpdir(), "siteindex-missing-browser.exe"), { headless: true }))
      .rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
  });
});
