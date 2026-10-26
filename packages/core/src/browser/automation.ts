import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  const { chromium } = await import(/* @vite-ignore */ "playwright-core");
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let userDataDir: string | null = null;
  try {
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
