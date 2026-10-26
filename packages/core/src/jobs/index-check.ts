/// <reference lib="dom" />
import { PATHS, type SeoPage } from "@siteindex/shared";
import path from "node:path";
import { writeJsonl } from "../io/jsonl";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../browser/automation";

const INDEX_CHECK_LIMIT = 50;
const CAPTCHA_SELECTOR = "iframe[src*='recaptcha'], #captcha-form, form[action*='/sorry/'], input[name='captcha']";

export interface IndexCheckOptions {
  projectPath: string;
  pages: SeoPage[];
  executablePath: string;
  launchBrowser: BrowserLauncher;
  checkedAt?: string;
  random?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface IndexCheckResult {
  checked: number;
  indexed: number;
  not_indexed: number;
  unchecked: number;
  captcha: boolean;
}

function siteError(code: "BROWSER_UNAVAILABLE" | "FEED_FETCH_FAILED", message: string, detail?: string) {
  return { code, message, ...(detail ? { detail } : {}) };
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${host}${pathname}`.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

function googleQueryUrl(target: string): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", `site:${target.replace(/^https?:\/\//i, "")}`);
  return url.toString();
}

async function isCaptcha(page: BrowserPage): Promise<boolean> {
  const count = await page.locator(CAPTCHA_SELECTOR).count().catch(() => 0);
  if (count > 0) return true;
  const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  return ["unusual traffic", "our systems have detected", "not a robot", "captcha", "automated queries"].some((marker) => text.includes(marker));
}

async function hasTargetResult(page: BrowserPage, targetUrl: string): Promise<boolean> {
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("#search a"), (anchor) => anchor.href));
  const target = normalizeUrl(targetUrl);
  return hrefs.some((href) => normalizeUrl(href) === target || normalizeUrl(href).startsWith(`${target}?`));
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runIndexCheck(options: IndexCheckOptions): Promise<IndexCheckResult> {
  if (!options.executablePath.trim()) throw siteError("BROWSER_UNAVAILABLE", "请由调用方提供 Chrome 或 Edge 的 executablePath。");
  const eligible = options.pages.filter((page) => typeof page.url === "string" && /^https?:\/\//i.test(page.url));
  const selected = eligible.slice(0, INDEX_CHECK_LIMIT);
  if (selected.length === 0) return { checked: 0, indexed: 0, not_indexed: 0, unchecked: 0, captcha: false };

  let browser: BrowserSession;
  try {
    browser = await options.launchBrowser(options.executablePath, { headless: false, persistent: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "BROWSER_UNAVAILABLE") throw error;
    throw siteError("BROWSER_UNAVAILABLE", "无法启动调用方提供的浏览器。请检查 Chrome/Edge 路径和权限。", error instanceof Error ? error.message : String(error));
  }

  const random = options.random ?? Math.random;
  const wait = options.wait ?? defaultWait;
  const checkedAt = options.checkedAt ?? new Date().toISOString().slice(0, 10);
  let checked = 0;
  let indexed = 0;
  let notIndexed = 0;
  let captcha = false;
  const updated = new Map<string, SeoPage>();
  try {
    const page = await browser.newPage();
    try {
      for (const [index, target] of selected.entries()) {
        if (index > 0) await wait(20_000 + Math.floor(Math.max(0, Math.min(0.999999, random())) * 20_001));
        try {
          await page.goto(googleQueryUrl(target.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch (error) {
          throw siteError("FEED_FETCH_FAILED", "无法读取 Google 收录查询结果。", error instanceof Error ? error.message : String(error));
        }
        if (await isCaptcha(page)) {
          captcha = true;
          break;
        }
        const present = await hasTargetResult(page, target.url);
        updated.set(target.url, { ...target, google_indexed: present, index_checked_at: checkedAt });
        checked += 1;
        if (present) indexed += 1;
        else notIndexed += 1;
      }
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }

  if (updated.size > 0) {
    const rows = options.pages.map((page) => updated.get(page.url) ?? page);
    await writeJsonl(path.join(options.projectPath, PATHS.seoPages), rows as unknown as Record<string, unknown>[], "seo_page");
  }
  return {
    checked,
    indexed,
    not_indexed: notIndexed,
    unchecked: eligible.length - checked,
    captcha,
  };
}
