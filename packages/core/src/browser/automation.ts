import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";

export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeout?: number }): Promise<unknown>;
  setViewportSize(viewport: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  locator(selector: string): { innerText(): Promise<string>; count(): Promise<number> };
  close(): Promise<void>;
}

export interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  headless: boolean;
  persistent?: boolean;
}

export type BrowserLauncher = (executablePath: string, options: BrowserLaunchOptions) => Promise<BrowserSession>;

/** cli.js 位于 resources/，依赖由 Electron 解包到 app.asar.unpacked/node_modules/。 */
export function loadPackagedPlaywright(resourcesDirectory: string): typeof import("playwright-core") {
  const requireFromUnpacked = createRequire(path.join(resourcesDirectory, "app.asar.unpacked", "package.json"));
  return requireFromUnpacked("playwright-core") as typeof import("playwright-core");
}

async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  try {
    return await import(/* @vite-ignore */ "playwright-core");
  } catch (originalError) {
    // 打包后的独立 CLI 位于 resources/cli.js，Node 不会从相邻的 app.asar.unpacked 查找依赖。
    const roots = [path.dirname(fileURLToPath(import.meta.url)), process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined];
    for (const root of roots) {
      if (!root) continue;
      try { return loadPackagedPlaywright(root); }
      catch { /* 继续检查另一打包路径 */ }
    }
    throw originalError;
  }
}

function pageAdapter(page: Page): BrowserPage {
  return {
    goto: (url, options) => page.goto(url, options),
    setViewportSize: (viewport) => page.setViewportSize(viewport),
    screenshot: (options) => page.screenshot(options),
    evaluate: <T>(pageFunction: () => T) => page.evaluate(pageFunction),
    locator: (selector) => page.locator(selector),
    close: () => page.close(),
  };
}

export const launchChromium: BrowserLauncher = async (executablePath, options) => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let userDataDir: string | null = null;
  try {
    const { chromium } = await loadPlaywright();
    if (options.persistent) {
      userDataDir = await mkdtemp(path.join(os.tmpdir(), "siteindex-google-check-"));
      context = await chromium.launchPersistentContext(userDataDir, { executablePath, headless: options.headless });
    } else {
      browser = await chromium.launch({ executablePath, headless: options.headless });
    }
  } catch (error) {
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw {
      code: "BROWSER_UNAVAILABLE",
      message: "无法启动调用方提供的浏览器。请检查 Chrome/Edge 路径和权限。",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    newPage: async () => pageAdapter(context ? await context.newPage() : await browser!.newPage()),
    close: async () => {
      try {
        if (context) await context.close();
        else await browser?.close();
      } finally {
        if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
};
