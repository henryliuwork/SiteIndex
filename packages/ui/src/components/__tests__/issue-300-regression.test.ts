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
      await page.locator('.si-seo-issue-actions summary[aria-label="问题操作：页面 4xx"]').first().waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle");
      await page.goto(`${baseUrl}/#/p/demo`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: "查看" }).first().waitFor({ state: "visible" });
      await page.getByRole("link", { name: "查看" }).first().click();
      await page.waitForURL(/#\/p\/demo\/seo/);

      const actionTrigger = page.locator('.si-seo-issue-actions summary[aria-label="问题操作：页面 4xx"]').first();
      await actionTrigger.waitFor({ state: "visible" });
      await actionTrigger.click();
      const actionMenu = actionTrigger.locator("xpath=..");
      const menuState = await actionMenu.evaluate((element) => ({
        open: (element as HTMLDetailsElement).open,
        text: element.textContent ?? "",
      }));
      if (!menuState.open || !menuState.text.includes("标记已处理")) {
        throw new Error(`Issue action menu did not open after clicking its trigger: ${JSON.stringify(menuState)}`);
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
});
