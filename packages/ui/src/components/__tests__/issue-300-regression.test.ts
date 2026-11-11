import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

let baseUrl = "";
const browserCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  ...(process.platform === "win32" ? [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]),
].filter((candidate): candidate is string => Boolean(candidate));
const executablePath = browserCandidates.find(existsSync);
// Keep the heavyweight browser run separate from the root Vitest pool; run this regression explicitly with SITEINDEX_RUN_BROWSER_REGRESSION=1.
const browserRegression = executablePath && process.env.SITEINDEX_RUN_BROWSER_REGRESSION === "1" ? it : it.skip;

describe("Issue #300 SEO row action hit testing", () => {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    if (!executablePath) return;
    const workspaceConfig = path.resolve(process.cwd(), "packages/ui/vite.config.ts");
    const configFile = existsSync(workspaceConfig) ? workspaceConfig : path.resolve(process.cwd(), "vite.config.ts");
    const root = path.dirname(configFile);
    server = await createServer({
      root,
      configFile,
      cacheDir: path.join(root, "node_modules/.vite/issue-300"),
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await server.listen();
    const httpServer = server.httpServer;
    if (!httpServer) throw new Error("Vite mock server did not start its HTTP server.");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Vite mock server did not expose its listening port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const optimizer = (server.environments.client as unknown as { depsOptimizer?: { scanProcessing?: Promise<unknown> } }).depsOptimizer;
    await optimizer?.scanProcessing;
    browser = await chromium.launch({ headless: true, executablePath });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60_000);

  browserRegression("allows clicking a row action after navigating from Overview to SEO", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      // 预热 SEO 懒加载路由，避免首次依赖扫描的重载打断真实回归步骤。
      await page.goto(`${baseUrl}/#/p/demo/seo`, { waitUntil: "domcontentloaded" });
      await page.locator(".si-seo-row-action").first().waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle");
      await page.goto(`${baseUrl}/#/p/demo`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: "查看" }).first().waitFor({ state: "visible" });
      await page.getByRole("link", { name: "查看" }).first().click();
      await page.waitForURL(/#\/p\/demo\/seo/);

      const actionTrigger = page.locator(".si-seo-row-action").first();
      await actionTrigger.waitFor({ state: "visible" });
      await actionTrigger.click();
      const actionMenu = page.locator(".si-seo-issue-menu").first();
      await actionMenu.waitFor({ state: "visible" });
      if (!(await actionMenu.innerText()).includes("标记已处理")) {
        throw new Error(`Issue action menu did not contain the expected action: ${await actionMenu.innerText()}`);
      }
      const menuItem = actionMenu.getByRole("menuitem", { name: "标记已处理" });
      await menuItem.waitFor({ state: "visible" });
      expect(await page.locator(".si-table td.is-sticky-right").count()).toBeGreaterThan(0);
      let dialogType: string | undefined;
      page.once("dialog", (dialog) => { dialogType = dialog.type(); void dialog.dismiss(); });
      await menuItem.click();
      expect(dialogType).toBe("confirm");
    } finally {
      await page.close();
    }
  }, 60_000);

  browserRegression("allows an SEO row action after ordinary wheel scrolling at 1100×720", async () => {
    const page = await browser!.newPage({ viewport: { width: 1100, height: 720 } });
    try {
      await page.goto(`${baseUrl}/#/p/demo/seo`, { waitUntil: "domcontentloaded" });
      const scroll = page.locator(".si-table-scroll").first();
      await scroll.waitFor({ state: "visible" });
      // Reproduce the 1100×720 packaged layout recorded by E: a fill table collapsed to a 55px scroll viewport.
      await page.addStyleTag({ content: `
        .si-seo-page .si-data-table.is-fill { height: 144px; min-height: 0; flex: 0 1 auto; }
        .si-seo-page .si-data-table.is-fill > .si-table-scroll { height: 55px; min-height: 0; flex: none; }
      ` });
      await page.waitForFunction(() => document.querySelector(".si-data-table")?.classList.contains("is-compact-fill"));
      const actionTrigger = page.locator(".si-seo-row-action").first();
      await actionTrigger.waitFor({ state: "visible" });
      const scrollBox = await scroll.boundingBox();
      if (!scrollBox) throw new Error("SEO table scroll area has no visible bounds.");
      const beforeScroll = await actionTrigger.evaluate((button) => {
        const target = button as HTMLElement;
        const bounds = target.getBoundingClientRect();
        const header = document.querySelector(".si-table th.is-sticky-right")?.getBoundingClientRect();
        const scrollArea = target.closest(".si-table-scroll") as HTMLElement | null;
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return {
          overlapsHeader: Boolean(header && bounds.top < header.bottom && bounds.bottom > header.top),
          scrollClientHeight: scrollArea?.clientHeight ?? 0,
          targetReceivesPointer: hit === target || target.contains(hit),
        };
      });
      expect(beforeScroll.scrollClientHeight).toBeGreaterThanOrEqual(80);
      expect(await page.locator(".si-data-table").first().evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(180);
      expect(beforeScroll.overlapsHeader).toBe(false);
      expect(beforeScroll.targetReceivesPointer).toBe(true);
      await page.mouse.move(scrollBox.x + scrollBox.width - 24, scrollBox.y + scrollBox.height / 2);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(100);

      // This is an ordinary Playwright pointer click: no force option and no DOM-dispatched click.
      await actionTrigger.click({ timeout: 5_000 });
      await page.locator(".si-seo-issue-menu").first().waitFor({ state: "visible" });
    } finally {
      await page.close();
    }
  }, 60_000);

  browserRegression("keeps the table and pagination reachable at compact and desktop viewports", async () => {
    for (const viewport of [{ width: 1100, height: 720 }, { width: 1440, height: 900 }]) {
      const page = await browser!.newPage({ viewport });
      try {
        await page.goto(`${baseUrl}/#/p/demo/seo`, { waitUntil: "domcontentloaded" });
        const table = page.locator(".si-data-table").first();
        const scroll = table.locator(".si-table-scroll");
        const pagination = table.locator(".si-pagination");
        await scroll.waitFor({ state: "visible" });
        await pagination.waitFor({ state: "visible" });
        const scrollClientHeight = await scroll.evaluate((element) => element.clientHeight);
        expect(scrollClientHeight).toBeGreaterThanOrEqual(80);

        const content = page.locator(".si-content");
        const contentBox = await content.boundingBox();
        if (!contentBox) throw new Error("Main content area has no visible bounds.");
        const before = await page.evaluate(() => {
          const contentElement = document.querySelector(".si-content") as HTMLElement;
          const scrollElement = document.querySelector(".si-table-scroll") as HTMLElement;
          const paginationElement = document.querySelector(".si-pagination") as HTMLElement;
          const paginationBox = paginationElement.getBoundingClientRect();
          return {
            outer: { scrollTop: contentElement.scrollTop, clientHeight: contentElement.clientHeight, scrollHeight: contentElement.scrollHeight },
            tableScroll: { clientHeight: scrollElement.clientHeight, scrollHeight: scrollElement.scrollHeight },
            pagination: { top: paginationBox.top, bottom: paginationBox.bottom, height: paginationBox.height },
          };
        });
        await page.mouse.move(contentBox.x + 5, contentBox.y + Math.min(120, contentBox.height / 2));
        await page.mouse.wheel(0, 640);
        await page.waitForTimeout(100);
        const after = await page.evaluate(() => {
          const contentElement = document.querySelector(".si-content") as HTMLElement;
          const paginationBox = (document.querySelector(".si-pagination") as HTMLElement).getBoundingClientRect();
          return {
            outerScrollTop: contentElement.scrollTop,
            pagination: { top: paginationBox.top, bottom: paginationBox.bottom, height: paginationBox.height },
          };
        });
        console.info(`[seo-table-layout ${viewport.width}x${viewport.height}] ${JSON.stringify({ before, after })}`);
        const paginationBox = await pagination.boundingBox();
        if (!paginationBox) throw new Error("DataTable pagination has no visible bounds.");
        expect(after.pagination.top).toBeGreaterThanOrEqual(0);
        expect(after.pagination.bottom).toBeLessThanOrEqual(viewport.height);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
