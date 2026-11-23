import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { inspectFrame } from "./frame-inspect";
import { checkFrameMetrics, checkSkuTables, projectSettingsScrollableBodyRoutes, type FrameBaseline } from "./frame-policy";
import { inspectTooltips } from "./tooltip-inspect";
import { createServer, type ViteDevServer } from "vite";
import { classifyDataSurface, classifyPageSurface, getVerticalScrollDelta, waitForDataSurface, waitForPageSurface, type DataSurfaceState, type PageSurfaceSnapshot } from "./readiness";
import { isDataTableRoute, routeCaseUrl } from "./routes";
import { checkSectionPageMetrics, SECTION_PAGE_NAMES, type SectionPageBaseline, type SectionPageMetrics } from "./section-page-policy";
import { compareStyleFindings, scanUiStyles, timeDisplayPatternSource, type StyleBaseline } from "./style-policy";

type BrowserChannel = "msedge" | "chrome";

interface RouteCase {
  name: string;
  path: string;
  waitForDataSurface?: boolean;
}

interface Viewport {
  width: number;
  height: number;
  headerOnly?: boolean;
}

interface CheckFailure {
  rule: string;
  message: string;
}

interface CheckReport {
  route: string;
  routeName: string;
  viewport: Viewport;
  heading: string | null;
  metrics: Record<string, unknown>;
  failures: CheckFailure[];
  consoleErrors: string[];
  timeWarnings: string[];
  sectionPageFindings?: ReturnType<typeof checkSectionPageMetrics>;
  frameStatus?: "strict" | "legacy";
}

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = process.env.SITEINDEX_UI_CHECK_SHOTS_DIR
  ? path.resolve(uiRoot, process.env.SITEINDEX_UI_CHECK_SHOTS_DIR)
  : path.join(uiRoot, ".shots");
const viewports: Viewport[] = [
  { width: 1024, height: 768, headerOnly: true }, // Extra compact viewport checks the shell/header; table viewport remains the 1280+ contract.
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const mockModeOverride = process.env.SITEINDEX_UI_CHECK_MOCK_MODE;
const mockModeRoute = process.env.SITEINDEX_UI_CHECK_MOCK_ROUTE ?? "/p/demo/design";

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function routeFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await routeFilesUnder(fullPath));
    else if (entry.isFile() && entry.name === "route.tsx") files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function discoverRoutes(server: ViteDevServer, projectId: string): Promise<RouteCase[]> {
  const pageRoot = path.join(uiRoot, "src", "pages");
  const files = await routeFilesUnder(pageRoot);
  const cases: RouteCase[] = [];
  for (const file of files) {
    const moduleId = "/" + path.relative(uiRoot, file).split(path.sep).join("/");
    const routeModule = await server.ssrLoadModule(moduleId);
    const routeValue: unknown = routeModule.route;
    if (!routeValue || typeof routeValue !== "object") continue;
    const routePath = Reflect.get(routeValue, "path");
    if (typeof routePath !== "string") continue;
    const name = path.basename(path.dirname(file));
    if (routePath === "/new/*") {
      for (const step of ["url", "source", "brand", "agent-workspace", "done"]) {
        cases.push({ name: `new-project-${step}`, path: `/new/${step}` });
      }
      cases.push({ name: "new-project-woo-detect", path: "/new/url" });
      cases.push({ name: "new-project-woo-source", path: "/new/source" });
    } else if (routePath === "*") {
      cases.push({ name: "not-found", path: "/__ui-check-not-found__" });
    } else {
      const path = routePath.replaceAll(":id", encodeURIComponent(projectId));
      cases.push({ name, path, waitForDataSurface: isDataTableRoute(path) });
      if (path === "/schedules") {
        cases.push({ name: "schedules-system", path, waitForDataSurface: true });
        cases.push({ name: "schedules-orphans", path, waitForDataSurface: true });
      }
    }
  }
  return cases;
}

async function advanceWizardCase(page: Page, route: RouteCase): Promise<void> {
  if (!route.name.startsWith("new-project-")) return;
  if (route.name !== "new-project-url") {
    await page.getByRole("textbox", { name: "网站地址" }).fill("woo.example.test");
    await page.getByRole("button", { name: "检测", exact: true }).click();
    await page.getByRole("list", { name: "Sitemap 类型" }).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("网站检测完成。").waitFor({ state: "visible", timeout: 5_000 });
    await page.getByRole("button", { name: "关闭通知" }).evaluateAll((buttons) => {
      for (const button of buttons) if (button.isConnected) (button as HTMLButtonElement).click();
    });
    if (route.name !== "new-project-woo-detect") {
      await page.getByRole("button", { name: "下一步：数据源" }).click();
      if (route.name === "new-project-woo-source") {
        const collect = page.getByRole("checkbox", { name: "自动采集商品" });
        if (!await collect.isChecked()) throw new Error("WooCommerce 无 Feed 时应默认启用商品采集。");
        await page.getByRole("button", { name: "使用 /shop/{slug}" }).click();
        await page.getByRole("button", { name: "使用 /product-category/{slug}" }).click();
        await page.getByText("将保存：/shop/{slug}，/product-category/{slug}").waitFor({ state: "visible", timeout: 15_000 });
      } else if (route.name !== "new-project-source") {
        await page.getByRole("button", { name: "下一步：品牌配置" }).click();
        if (route.name !== "new-project-brand") {
          await page.getByRole("button", { name: "下一步：Agent 工作区" }).click();
          if (route.name === "new-project-done") {
            await page.getByText("目标目录为空，可以继续。").waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "创建项目" }).click();
          }
        }
      }
    }
  }
  await page.waitForURL((url) => url.hash === `#${route.path}`, { timeout: 20_000 });
  const surface = route.name === "new-project-done" ? ".si-wizard-progress-card"
    : route.name === "new-project-agent-workspace" ? ".si-wizard-workspace-layout"
    : route.path === "/new/brand" ? ".si-wizard-location-card"
    : route.path === "/new/source" ? ".si-wizard-source-layout"
    : ".si-wizard-url-card";
  await page.locator(surface).waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector(".si-page-frame-body")?.scrollTop ?? -1) === 0, undefined, { timeout: 5_000 });
}

async function discoverMockProjectId(server: ViteDevServer): Promise<string> {
  const mockContext = await server.ssrLoadModule("/src/mock/context.ts");
  const fixtures = Reflect.get(mockContext, "fixtures");
  const projects = fixtures && Reflect.get(fixtures, "projects");
  const firstProject = Array.isArray(projects) ? projects[0] : undefined;
  const projectId = firstProject && Reflect.get(firstProject, "id");
  if (typeof projectId !== "string" || !projectId) {
    throw new Error("Mock 数据没有提供项目 ID，无法生成项目级路由检查。");
  }
  return projectId;
}

async function launchLocalBrowser(): Promise<Browser> {
  const configured = process.env.SITEINDEX_BROWSER_CHANNEL;
  if (configured && configured !== "msedge" && configured !== "chrome") {
    throw new Error("SITEINDEX_BROWSER_CHANNEL 只能是 msedge 或 chrome。");
  }
  const channels: BrowserChannel[] = configured === "msedge" || configured === "chrome"
    ? [configured]
    : process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  const errors: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      errors.push(`${channel}: ${asErrorMessage(error)}`);
    }
  }
  throw new Error(`找不到本机 Edge 或 Chrome；不会下载浏览器。${errors.join(" | ")}`);
}

async function readSurfaceSnapshot(page: Page): Promise<PageSurfaceSnapshot> {
  return page.evaluate(() => {
    const table = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-table-scroll")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const pagination = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-pagination [aria-label='每页条数']")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const hasVisibleRows = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table")).some((tableElement) =>
      tableElement.getBoundingClientRect().width > 0 && tableElement.getBoundingClientRect().height > 0
      && Array.from(tableElement.querySelectorAll<HTMLElement>(".si-table tbody tr[data-row-id]")).some((row) => {
        const rect = row.getBoundingClientRect();
        if (!row.isConnected || row.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
        for (let current: HTMLElement | null = row; current && current !== document.documentElement; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        return true;
      }),
    );
    const emptyElementVisible = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-table-empty, .si-page [data-table-empty], .si-content-blog-empty")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const pageEmptyElementVisible = Array.from(document.querySelectorAll<HTMLElement>(".si-page [data-table-empty], .si-empty-state, .si-content-blog-empty")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const error = Array.from(document.querySelectorAll<HTMLElement>(".si-page .si-api-error-state, main .si-api-error-state")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const loadingElementVisible = Array.from(document.querySelectorAll<HTMLElement>(
      ".si-page-loading, .si-query-loading, .si-inventory-query-state, .si-content-blog-empty [role='status']",
    )).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const content = Array.from(document.querySelectorAll<HTMLElement>(
        "main .si-page > :not(.si-page-header):not(.si-project-header):not(.si-page-loading):not(.si-api-error-state):not(.si-empty-state):not(.si-content-blog-empty):not(.si-tab-panel), main .si-tab-panel > :not(.si-page-loading):not(.si-query-loading):not(.si-api-error-state):not(.si-empty-state):not(.si-content-blog-empty), main .si-placeholder",
    )).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    return {
      table,
      pagination,
      empty: emptyElementVisible && !hasVisibleRows,
      pageEmpty: pageEmptyElementVisible && !hasVisibleRows,
      error,
      loading: Number(Reflect.get(window, "__siteindexMockPendingRequests") ?? 0) > 0 || loadingElementVisible,
      // PageHeader and ProjectHeader can render before their queries complete.
      // Require a visible body surface; explicit loading/error/empty states are handled separately.
      content,
    };
  });
}

async function readDataSurfaceState(page: Page): Promise<DataSurfaceState> {
  return classifyDataSurface(await readSurfaceSnapshot(page));
}

async function readPageSurfaceState(page: Page): Promise<DataSurfaceState> {
  return classifyPageSurface(await readSurfaceSnapshot(page));
}

async function waitForRoute(page: Page, route: RouteCase): Promise<DataSurfaceState> {
  await page.locator(".si-page, .si-placeholder, .si-api-error-state, .si-empty-state, [data-table-empty], .si-content-blog-empty").first().waitFor({ state: "visible", timeout: 20_000 });
  if (route.waitForDataSurface) {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    const state = await waitForDataSurface(() => readDataSurfaceState(page));
    await page.evaluate(() => document.fonts.ready);
    return state;
  }
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  const state = await waitForPageSurface(() => readPageSurfaceState(page));
  await page.evaluate(() => document.fonts.ready);
  return state;
}

async function scrollCheckViewportTableIntoContent(page: Page): Promise<void> {
  const target = await page.evaluate(() => {
    const scrollArea = Array.from(document.querySelectorAll<HTMLElement>(".si-table-scroll")).find((element) => {
      const table = element.closest<HTMLElement>(".si-data-table");
      if (!table?.classList.contains("is-fill") && !element.closest(".si-table-region")) return false;
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const table = scrollArea?.closest<HTMLElement>(".si-data-table");
    const targetElement = table ?? scrollArea?.closest<HTMLElement>(".si-table-region");
    const content = targetElement?.closest<HTMLElement>(".si-content");
    if (!targetElement || !content) return null;
    const overflowY = getComputedStyle(content).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") return null;

    const targetRect = targetElement.getBoundingClientRect();
    const viewportRect = content.getBoundingClientRect();
    const viewportTop = viewportRect.top + content.clientTop;
    return {
      target: { top: targetRect.top, bottom: targetRect.bottom },
      viewport: { top: viewportTop, bottom: viewportTop + content.clientHeight },
      scrollTop: content.scrollTop,
    };
  });
  if (!target) return;

  const delta = getVerticalScrollDelta(target.target, target.viewport);
  if (delta === 0) return;

  await page.evaluate((scrollTop) => {
    const content = document.querySelector<HTMLElement>(".si-content");
    if (content) content.scrollTop = scrollTop;
  }, target.scrollTop + delta);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// D9 settings pages scroll their PageFrame body. Check each embedded table after
// scrolling its footer into that viewport, then restore the user's deep-link position.
async function inspectSettingsTableReachability(page: Page): Promise<Array<{ bottomInViewport: boolean; paginationInViewport: boolean } | null>> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".si-page-frame.is-content > .si-page-frame-body");
    if (!body) return [];
    const initialScrollTop = body.scrollTop;
    const viewport = body.getBoundingClientRect();
    const areas = Array.from(document.querySelectorAll<HTMLElement>(".si-table-scroll")).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const results: Array<{ bottomInViewport: boolean; paginationInViewport: boolean } | null> = [];
    try {
      for (const area of areas) {
        const table = area.closest<HTMLElement>(".si-data-table");
        if (!table?.classList.contains("is-fill") && !area.closest(".si-table-region")) {
          results.push(null);
          continue;
        }
        const footer = table.querySelector<HTMLElement>(".si-pagination");
        const targetBottom = footer?.getBoundingClientRect().bottom ?? area.getBoundingClientRect().bottom;
        body.scrollTop += targetBottom - viewport.bottom;
        const areaRect = area.getBoundingClientRect();
        const footerRect = footer?.getBoundingClientRect();
        results.push({
          bottomInViewport: areaRect.bottom > viewport.top && areaRect.bottom <= viewport.bottom + 1,
          paginationInViewport: Boolean(footerRect && footerRect.top >= viewport.top - 1 && footerRect.bottom <= viewport.bottom + 1),
        });
      }
    } finally {
      body.scrollTop = initialScrollTop;
    }
    return results;
  });
}

async function inspectPage(page: Page): Promise<{
  heading: string | null;
  metrics: Record<string, unknown>;
  timeWarnings: string[];
}> {
  return page.evaluate(async (timePattern) => {
    // Force the packaged fallback to load even where a system Chinese font wins the stack.
    await document.fonts.load('12px "Source Han Sans SC"', "中文");
    const root = document.scrollingElement ?? document.documentElement;
    const bodyStyle = getComputedStyle(document.body);
    const firstFont = bodyStyle.fontFamily.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
    const geistFontLoaded = Array.from(document.fonts).some((font) => font.family.replace(/^['"]|['"]$/g, "") === "Geist Variable" && font.status === "loaded");
    const sourceHanFontLoaded = Array.from(document.fonts).some((font) => font.family.replace(/^['"]|['"]$/g, "") === "Source Han Sans SC" && font.status === "loaded");
    const sharedTypographyElements = Array.from(document.querySelectorAll<HTMLElement>([
      ".si-title", ".si-nav-link", ".si-nav-caption", ".si-button", ".si-filter-pill",
      ".si-segmented button", ".si-tabs button", ".si-chip", ".si-length-badge",
      ".si-checkbox-row", ".si-pagination", ".si-search-input input", ".si-collapse-toggle",
      ".si-runner", ".si-page-header *", ".si-project-header *", ".si-drawer *",
      ".si-toast *", ".si-notice *", ".si-empty-state *", ".si-update-reminder *",
    ].join(", "))).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && Number.parseFloat(getComputedStyle(element).fontSize) < 10;
    }).map((element) => element.innerText?.trim().slice(0, 60) || element.className.toString());
    const clippedHeaderActions: string[] = [];
    for (const slot of Array.from(document.querySelectorAll<HTMLElement>(".si-project-header-action-slot"))) {
      const actions = slot.querySelector<HTMLElement>(".si-project-header-actions");
      if (!actions) continue;
      const viewport = actions.getBoundingClientRect();
      for (const control of Array.from(actions.querySelectorAll<HTMLElement>("button, a[href], [role='button']"))) {
        const rect = control.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.left < viewport.left - 1 || rect.right > viewport.right + 1) {
          const label = control.getAttribute("aria-label") || control.innerText.trim() || control.tagName.toLowerCase();
          clippedHeaderActions.push(`${label} [${Math.round(rect.left)}–${Math.round(rect.right)} / ${Math.round(viewport.left)}–${Math.round(viewport.right)}]`);
        }
      }
    }
    const clippedActiveTabs: string[] = [];
    const headerScrollbars: string[] = [];
    const verticallyScrollableTablists: string[] = [];
    for (const tablist of Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"]'))) {
      if (tablist.scrollHeight > tablist.clientHeight) {
        verticallyScrollableTablists.push(tablist.getAttribute("aria-label") || tablist.className || "tablist");
      }
    }
    const settingInputHeights = Array.from(document.querySelectorAll<HTMLElement>(".si-app-settings-page .si-setting-input"))
      .map((element) => Math.round(element.getBoundingClientRect().height));
    const skillTargetButtonHeights = Array.from(document.querySelectorAll<HTMLElement>(".si-skills-page .si-skill-target > .si-button"))
      .map((element) => Math.round(element.getBoundingClientRect().height));
    for (const selector of [".si-project-header .si-tabs", ".si-project-header-actions"]) {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const style = getComputedStyle(element);
        if (element.scrollWidth > element.clientWidth || ["auto", "scroll"].includes(style.overflowX)) headerScrollbars.push(selector);
      }
    }
    for (const tabs of Array.from(document.querySelectorAll<HTMLElement>(".si-project-header .si-tabs"))) {
      const activeTab = tabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!activeTab) continue;
      const viewport = tabs.getBoundingClientRect();
      const rect = activeTab.getBoundingClientRect();
      if (rect.width > 0 && (rect.left < viewport.left - 1 || rect.right > viewport.right + 1)) {
        clippedActiveTabs.push(activeTab.innerText.trim());
      }
    }
    const documentElement = document.documentElement;
    const horizontalOverflow = Math.max(documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1;
    const verticalOverflow = root.scrollHeight > root.clientHeight + 1;

    const clippedCells: string[] = [];
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>("th, td"))) {
      const visibleClone = cell.cloneNode(true) as HTMLElement;
      for (const hiddenText of Array.from(visibleClone.querySelectorAll<HTMLElement>(".si-sr-only, .sr-only, [data-sr-only]"))) hiddenText.remove();
      const text = visibleClone.innerText.trim().replace(/\s+/g, " ");
      if (!text) continue;
      const descendants = [cell, ...Array.from(cell.querySelectorAll<HTMLElement>("*"))]
        .filter((element) => !element.matches(".si-sr-only, .sr-only, [data-sr-only]") && !element.closest(".si-sr-only, .sr-only, [data-sr-only]"));
      const overflowing = descendants.some((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2);
      if (!overflowing) continue;
      const hasFullTextHint = Boolean(cell.title || cell.getAttribute("aria-label") || cell.querySelector<HTMLElement>("[title]")?.title);
      const explicitlyClamped = descendants.some((element) => {
        const style = getComputedStyle(element);
        const lineClamp = style.getPropertyValue("-webkit-line-clamp");
        return style.textOverflow === "ellipsis" || (lineClamp !== "" && lineClamp !== "none");
      });
      if (!hasFullTextHint && !explicitlyClamped) clippedCells.push(text.slice(0, 100));
    }

    const tables = Array.from(document.querySelectorAll<HTMLElement>(".si-table-scroll")).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const hasVisibleRows = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-table tbody tr[data-row-id]")).some((row) => {
      const rect = row.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = row; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const emptySurface = !hasVisibleRows && Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-table-empty, .si-page [data-table-empty], .si-empty-state, .si-content-blog-empty")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const contentSurface = Array.from(document.querySelectorAll<HTMLElement>(
      "main .si-page > :not(.si-page-header):not(.si-project-header):not(.si-page-loading):not(.si-api-error-state):not(.si-empty-state):not(.si-content-blog-empty):not(.si-tab-panel), main .si-tab-panel > :not(.si-page-loading):not(.si-query-loading):not(.si-api-error-state):not(.si-empty-state):not(.si-content-blog-empty), main .si-placeholder",
    )).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const errorSurface = Array.from(document.querySelectorAll<HTMLElement>(".si-page .si-api-error-state, main .si-api-error-state")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const tableMetrics = tables.map((scrollArea) => {
      const rect = scrollArea.getBoundingClientRect();
      const table = scrollArea.closest<HTMLElement>(".si-data-table");
      const footer = table?.querySelector<HTMLElement>(".si-pagination") ?? null;
      const footerRect = footer?.getBoundingClientRect() ?? null;
      const pageSize = footer?.querySelector<HTMLElement>('[aria-label="每页条数"]') ?? null;
      const checkViewport = Boolean(table?.classList.contains("is-fill") || scrollArea.closest(".si-table-region"));
      let footerVisible = Boolean(footer && footerRect && footerRect.width > 0 && footerRect.height > 0);
      for (let current: HTMLElement | null = footer; footerVisible && current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") footerVisible = false;
      }
      return {
        overflowY: getComputedStyle(scrollArea).overflowY,
        bottom: Math.round(rect.bottom),
        bottomInViewport: rect.bottom <= window.innerHeight + 1 && rect.bottom > 0,
        checkViewport,
        hasPagination: Boolean(footer),
        paginationBottom: footerRect ? Math.round(footerRect.bottom) : null,
        paginationInViewport: Boolean(footerVisible && footerRect && footerRect.top >= 0 && footerRect.bottom <= window.innerHeight + 1),
        hasPageSizeControl: Boolean(pageSize),
      };
    });

    const clickMisses: string[] = [];
    const clickTargets = Array.from(document.querySelectorAll<HTMLElement>(
      ".si-table tbody button:not(:disabled), .si-table tbody a[href], .si-table tbody summary, .si-table tbody [role='button'], .si-table tbody tr.is-clickable",
    )).filter((target) => !target.closest("[data-radix-popper-content-wrapper], [role='menu']"));
    for (const target of clickTargets) {
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      if (rect.width < 2 || rect.height < 2 || style.display === "none" || style.visibility === "hidden") continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) continue;
      let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let ancestor = target.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (ancestorStyle.overflowX !== "visible") {
          const ancestorRect = ancestor.getBoundingClientRect();
          clip.left = Math.max(clip.left, ancestorRect.left);
          clip.right = Math.min(clip.right, ancestorRect.right);
        }
        if (ancestorStyle.overflowY !== "visible") {
          const ancestorRect = ancestor.getBoundingClientRect();
          clip.top = Math.max(clip.top, ancestorRect.top);
          clip.bottom = Math.min(clip.bottom, ancestorRect.bottom);
        }
      }
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX < clip.left || centerX > clip.right || centerY < clip.top || centerY > clip.bottom) continue;
      const hit = document.elementFromPoint(centerX, centerY);
      if (hit !== target && !target.contains(hit) && hit?.closest("button, a[href], summary, [role='button']") !== target) {
        const label = target.getAttribute("aria-label") || target.innerText.trim() || target.tagName.toLowerCase();
        const hitClass = hit?.getAttribute("class") ? `.${hit.getAttribute("class")!.trim().replace(/\s+/g, ".")}` : "";
        clickMisses.push(`${label.slice(0, 80)} → ${hit?.tagName.toLowerCase() ?? "空白"}${hitClass}`);
      }
    }

    const timeRoot = document.createElement("div");
    for (const header of Array.from(document.querySelectorAll<HTMLElement>("main .si-project-header, main .si-page-header"))) {
      const headerClone = header.cloneNode(true) as HTMLElement;
      headerClone.querySelectorAll(".si-data-table, table, [role='dialog'], .si-toast, .si-popover").forEach((element) => element.remove());
      timeRoot.append(headerClone);
    }
    const timeDisplayCount = (timeRoot?.innerText.match(new RegExp(timePattern, "g")) ?? []).length;
    const timeWarnings = timeDisplayCount > 1 ? [`页面主体含 ${timeDisplayCount} 处日期或时间展示，需人工确认是否重复。`] : [];

    const pageRoot = document.querySelector<HTMLElement>("main .si-page");
    const pageTexts: string[] = [];
    if (pageRoot) {
      const walker = document.createTreeWalker(pageRoot, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest("[aria-hidden='true'], [role='dialog'], .si-detail-panel, .si-drawer, .si-popover-content")) continue;
        const rect = parent.getBoundingClientRect();
        const style = getComputedStyle(parent);
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight
          || rect.right <= 0 || rect.left >= innerWidth || style.display === "none" || style.visibility === "hidden") continue;
        const scrollArea = parent.closest<HTMLElement>(".si-table-scroll");
        if (scrollArea) {
          const scrollRect = scrollArea.getBoundingClientRect();
          if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) continue;
        }
        pageTexts.push(node.textContent ?? "");
      }
    }
    const visiblePageText = pageTexts.join(" ");
    const visibleTimes = visiblePageText.match(/\b(?:20\d{2}-)?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\b/g) ?? [];
    const segments = pageRoot ? Array.from(pageRoot.querySelectorAll<HTMLElement>(".si-segmented"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !element.closest("[role='dialog'], .si-detail-panel, .si-drawer");
      }) : [];
    const firstTable = tables[0];
    const headerRect = firstTable?.querySelector("thead th")?.getBoundingClientRect();
    const scrollRect = firstTable?.getBoundingClientRect();
    const sectionPage: SectionPageMetrics = {
      conditionalBannerVisible: Boolean(pageRoot && Array.from(pageRoot.querySelectorAll<HTMLElement>(".si-notice"))
        .some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !element.closest("[role='dialog'], .si-detail-panel, .si-drawer");
        })),
      tableHeaderTop: headerRect ? Math.round(headerRect.top) : null,
      visibleRowCapacity: headerRect && scrollRect ? Math.max(0, Math.floor((Math.min(scrollRect.bottom, innerHeight) - headerRect.bottom) / 52)) : null,
      visibleTimeCount: visibleTimes.length,
      segmentGroupCount: segments.length,
      segmentCountBadgeCount: segments.reduce((count, segment) => count + Array.from(segment.querySelectorAll<HTMLElement>("button"))
        .filter((button) => /\d/.test(button.innerText) || Boolean(button.querySelector(".si-chip, [class*='badge']"))).length, 0),
      relativeTimeCount: (visiblePageText.match(/今天|昨天/g) ?? []).length,
      horizontalScrollerCount: pageRoot ? Array.from(pageRoot.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !element.closest("[role='dialog'], .si-detail-panel, .si-drawer")
            && ["auto", "scroll"].includes(getComputedStyle(element).overflowX)
            && element.scrollWidth > element.clientWidth + 1;
        }).length : 0,
    };

    return {
      heading: document.querySelector("main h1")?.textContent?.trim() ?? null,
      metrics: {
        verticalOverflow,
        documentScrollHeight: root.scrollHeight,
        documentClientHeight: root.clientHeight,
        horizontalOverflow,
        documentScrollWidth: documentElement.scrollWidth,
        documentClientWidth: documentElement.clientWidth,
        contentScrollTop: document.querySelector<HTMLElement>(".si-content")?.scrollTop ?? null,
        bodyFontSize: bodyStyle.fontSize,
        bodyFontFamily: bodyStyle.fontFamily,
        bodyFirstFontIsGeist: /^geist variable$/i.test(firstFont),
        geistFontLoaded,
        sourceHanFontLoaded,
        sharedTypographyElements,
        clippedHeaderActions,
        clippedActiveTabs,
        headerScrollbars,
        verticallyScrollableTablists,
        settingInputHeights,
        skillTargetButtonHeights,
        tableCount: tables.length,
        emptySurface,
        contentSurface,
        errorSurface,
        scheduleTableMissingStandardScroll: Boolean(document.querySelector(".si-schedules-page table")) && !tables.length,
        tables: tableMetrics,
        clippedCells: clippedCells.slice(0, 12),
        inlineClickTargetCount: clickTargets.length,
        inlineClickMisses: clickMisses,
        sectionPage,
      },
      timeWarnings,
    };
  }, timeDisplayPatternSource);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

async function inspectProductVariantSku(page: Page): Promise<CheckFailure[]> {
  const firstRow = page.locator('[aria-label="products.merged 数据表"] tbody tr[data-row-id]').first();
  if (!await firstRow.count()) return [];
  try {
    await firstRow.click();
    await page.getByRole("button", { name: "变体库存", exact: true }).click({ timeout: 10_000 });
    await page.locator('[aria-label="products.variant-stock 数据表"]').waitFor({ state: "visible", timeout: 10_000 });
    const variant = (await inspectFrame(page)).tables.filter((table) => table.id === "products.variant-stock");
    return variant.length ? checkSkuTables("variant", variant)
      : [{ rule: "sku-variant-missing", message: "变体库存表已打开，但无法读取其列。" }];
  } catch (error) {
    return [{ rule: "sku-variant-check", message: `无法验证可触达的变体库存表：${asErrorMessage(error)}` }];
  }
}

async function main(): Promise<void> {
  await mkdir(shotsDir, { recursive: true });
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const reports: CheckReport[] = [];
  const allTimeWarnings = new Set<string>();
  const styleFindings = await scanUiStyles(path.join(uiRoot, "src"));
  const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "style-baseline.json");
  const styleBaselineFile = JSON.parse(await readFile(baselinePath, "utf8")) as { version: number; counts: StyleBaseline };
  const sectionBaselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "section-page-baseline.json");
  const sectionBaseline = JSON.parse(await readFile(sectionBaselinePath, "utf8")) as SectionPageBaseline;
  const frameBaselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "frame-baseline.json");
  const frameBaseline = JSON.parse(await readFile(frameBaselinePath, "utf8")) as FrameBaseline;
  const stylePolicy = compareStyleFindings(styleFindings, styleBaselineFile.counts);

  try {
    const linkedNodeModules = await realpath(path.resolve(uiRoot, "..", "..", "node_modules"));
    server = await createServer({
      root: uiRoot,
      configFile: path.join(uiRoot, "vite.config.ts"),
      cacheDir: path.join(uiRoot, "node_modules", ".vite", "ui-check"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        fs: { allow: [uiRoot, path.resolve(uiRoot, "..", ".."), linkedNodeModules] },
      },
    });
    await server.listen();
    const httpServer = server.httpServer;
    if (!httpServer) throw new Error("Vite mock server did not start its HTTP server.");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Vite mock server did not expose its listening port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const optimizer = (server.environments.client as unknown as { depsOptimizer?: { scanProcessing?: Promise<unknown> } }).depsOptimizer;
    await optimizer?.scanProcessing;

    browser = await launchLocalBrowser();
    const projectId = await discoverMockProjectId(server);
    const routes = await discoverRoutes(server, projectId);
    const unknownBaselineRoutes = Object.keys(frameBaseline.legacyRoutes).filter((name) => !routes.some((route) => route.name === name));
    if (unknownBaselineRoutes.length) throw new Error(`外框基线包含已不存在的路由：${unknownBaselineRoutes.join("、")}`);

    console.log(`ui:check: ${routes.length} routes × ${viewports.length} viewports; project=${projectId}`);
    if (mockModeOverride) console.log(`ui:check mock override: ${mockModeOverride} on ${mockModeRoute}`);
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      let currentConsoleErrors: string[] | null = null;
      page.on("console", (message) => {
        if (message.type() === "error") currentConsoleErrors?.push(message.text());
      });
      page.on("pageerror", (error) => currentConsoleErrors?.push(error.message));

      for (const route of routes) {
        const failures: CheckFailure[] = [];
        const consoleErrors: string[] = [];
        let heading: string | null = null;
        let metrics: Record<string, unknown> = {};
        let timeWarnings: string[] = [];
        let sectionPageFindings: ReturnType<typeof checkSectionPageMetrics> | undefined;
        let frameStatus: "strict" | "legacy" | undefined;
        currentConsoleErrors = consoleErrors;
        try {
          const mockQuery = mockModeOverride && route.path === mockModeRoute ? `/?mock=${encodeURIComponent(mockModeOverride)}` : "/";
          await page.goto(routeCaseUrl(baseUrl, mockQuery, route.name.startsWith("new-project-") ? "/new/url" : route.path, route.name), { waitUntil: "domcontentloaded", timeout: 20_000 });
          await advanceWizardCase(page, route);
          const dataSurfaceState = await waitForRoute(page, route);
          if (route.name === "schedules-system" || route.name === "schedules-orphans") {
            const system = route.name === "schedules-system";
            await page.locator(".si-page-frame-header").getByRole("button", { name: system ? "系统计划任务" : "孤立任务", exact: true }).click();
            const panel = page.locator(system ? "#si-schedule-system-panel" : "#si-schedule-orphans-panel");
            await panel.waitFor({ state: "visible" });
            await panel.locator(system ? ".si-system-task-row, .si-empty-state, .si-api-error-state" : ".si-orphan-schedule-list li, .si-empty-state, .si-api-error-state").first().waitFor({ state: "visible" });
          }
          if (route.path === "/skills") {
            await page.locator(".si-skill-choice").filter({ hasText: "stock-report" }).click();
            await page.locator(".si-skill-target > .si-button").first().waitFor({ state: "visible", timeout: 10_000 });
          }
          // Section-page gates measure the first screen, before legacy table-visibility scrolling.
          const firstScreenSectionPage = SECTION_PAGE_NAMES.some((name) => name === route.name)
            ? (await inspectPage(page)).metrics.sectionPage as SectionPageMetrics : undefined;
          await scrollCheckViewportTableIntoContent(page);
          const inspection = await inspectPage(page);
          if (projectSettingsScrollableBodyRoutes.has(route.name)) {
            const reached = await inspectSettingsTableReachability(page);
            const tables = inspection.metrics.tables as Array<{ bottomInViewport: boolean; paginationInViewport: boolean }>;
            reached.forEach((result, index) => { if (result && tables[index]) Object.assign(tables[index], result); });
          }
          heading = inspection.heading;
          metrics = { ...inspection.metrics, sectionPage: firstScreenSectionPage ?? inspection.metrics.sectionPage, dataSurfaceState };
          const frame = await inspectFrame(page);
          metrics.frame = frame;
          const frameCheck = checkFrameMetrics(route.name, route.path.startsWith("/p/") ? "project" : "global", Number(inspection.metrics.tableCount) > 0, frame, frameBaseline);
          frameStatus = frameCheck.status;
          failures.push(...frameCheck.findings);
          if (route.path === "/") {
            const title = await page.locator(".si-page-frame-header h1").boundingBox();
            const header = await page.locator(".si-page-frame-header").boundingBox();
            if (!title || !header || title.y + title.height > header.y + header.height + 1) {
              failures.push({ rule: "project-center-title-overflow", message: "项目中心标题越过 56px 标题行。" });
            }
          }
          if (route.path === "/skills") {
            const nestedScroll = await page.locator(".si-skill-body").evaluate((element) => {
              const overflow = getComputedStyle(element).overflowY;
              return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1;
            });
            if (nestedScroll || frame.contentScroll || frame.documentScroll) {
              failures.push({ rule: "skills-single-scroll", message: "Skill 页只能由 PageFrame 内容区纵向滚动。" });
            }
          }
          timeWarnings = inspection.timeWarnings;
          for (const warning of timeWarnings) allTimeWarnings.add(`${route.path} @ ${viewport.width}: ${warning}`);

          const values = metrics as {
            verticalOverflow: boolean;
            horizontalOverflow: boolean;
            bodyFontSize: string;
            bodyFontFamily: string;
            bodyFirstFontIsGeist: boolean;
            geistFontLoaded: boolean;
            sourceHanFontLoaded: boolean;
            sharedTypographyElements: string[];
            clippedHeaderActions: string[];
            clippedActiveTabs: string[];
            headerScrollbars: string[];
            verticallyScrollableTablists: string[];
            settingInputHeights: number[];
            skillTargetButtonHeights: number[];
            tableCount: number;
            emptySurface: boolean;
            contentSurface: boolean;
            errorSurface: boolean;
            scheduleTableMissingStandardScroll: boolean;
            tables: Array<{ overflowY: string; bottomInViewport: boolean; checkViewport: boolean; hasPagination: boolean; paginationBottom: number | null; paginationInViewport: boolean; hasPageSizeControl: boolean }>;
            clippedCells: string[];
            inlineClickMisses: string[];
            sectionPage: SectionPageMetrics;
            dataSurfaceState?: DataSurfaceState;
          };
          if (SECTION_PAGE_NAMES.some((name) => name === route.name)) {
            sectionPageFindings = checkSectionPageMetrics(values.sectionPage, viewport.width, sectionBaseline.checks[`${route.name}@${viewport.width}`]);
            for (const finding of sectionPageFindings.filter((item) => !item.legacy)) {
              failures.push({ rule: finding.rule, message: `板块页指标 ${finding.actual}，目标 ${finding.limit}。` });
            }
          }
          if (route.waitForDataSurface && values.dataSurfaceState === "table" && !values.tableCount) {
            failures.push({ rule: "table-readiness-mismatch", message: "就绪判定为表格已加载，但截图测量没有可见表格滚动区。" });
          }
          if (route.waitForDataSurface && values.dataSurfaceState === "empty" && !values.emptySurface) {
            failures.push({ rule: "table-readiness-mismatch", message: "就绪判定为空态，但截图测量没有可见空态。" });
          }
          if (route.waitForDataSurface && values.dataSurfaceState === "error" && !values.errorSurface) {
            failures.push({ rule: "table-readiness-mismatch", message: "就绪判定为错误态，但截图测量没有可见错误。" });
          }
          if (!route.waitForDataSurface && values.dataSurfaceState === "content" && !values.contentSurface) {
            failures.push({ rule: "page-readiness-mismatch", message: "就绪判定为内容完成，但截图测量没有可见页面内容。" });
          }
          if (!route.waitForDataSurface && values.dataSurfaceState === "empty" && !values.emptySurface) {
            failures.push({ rule: "page-readiness-mismatch", message: "就绪判定为空态，但截图测量没有可见空态。" });
          }
          if (!route.waitForDataSurface && values.dataSurfaceState === "error" && !values.errorSurface) {
            failures.push({ rule: "page-readiness-mismatch", message: "就绪判定为错误态，但截图测量没有可见错误。" });
          }
          if (values.verticalOverflow) failures.push({ rule: "vertical-overflow", message: "窗口 document 有纵向滚动；内容应在应用内部滚动。" });
          if (values.horizontalOverflow) failures.push({ rule: "horizontal-overflow", message: "页面内容超出视口宽度。" });
          if (values.bodyFontSize !== "12px" || !values.bodyFirstFontIsGeist || !values.geistFontLoaded || !values.sourceHanFontLoaded) {
            failures.push({ rule: "body-font", message: `正文要求 Geist Variable 12px 且随包 Source Han Sans SC 可离线加载，实际为 ${values.bodyFontFamily ?? "unknown"} / ${values.bodyFontSize ?? "unknown"}，字体加载=${values.geistFontLoaded ?? false}/${values.sourceHanFontLoaded ?? false}。` });
          }
          if (values.sharedTypographyElements.length) failures.push({ rule: "shared-min-font-size", message: `共享控件存在小于 10px 的文字：${values.sharedTypographyElements.join("；")}` });
          if (values.clippedHeaderActions.length) failures.push({ rule: "project-header-actions", message: `页头操作按钮未完整显示：${values.clippedHeaderActions.join("；")}` });
          if (values.clippedActiveTabs.length) failures.push({ rule: "project-header-tabs", message: `当前项目标签未完整显示：${values.clippedActiveTabs.join("；")}` });
          if (values.headerScrollbars.length) failures.push({ rule: "project-header-scrollbar", message: `项目导航或页头操作区存在横向滚动：${values.headerScrollbars.join("；")}` });
          if (values.verticallyScrollableTablists.length) failures.push({ rule: "tablist-vertical-scrollbar", message: `标签栏存在纵向滚动：${values.verticallyScrollableTablists.join("；")}` });
          if (route.path === "/settings" && (!values.settingInputHeights.length || values.settingInputHeights.some((height) => height !== 32))) failures.push({ rule: "setting-input-height", message: `设置输入框高度应为 32px，实际 ${values.settingInputHeights.join("、") || "未渲染"}。` });
          if (route.path === "/skills" && (!values.skillTargetButtonHeights.length || values.skillTargetButtonHeights.some((height) => height !== 32))) failures.push({ rule: "skill-target-button-height", message: `Skill 安装按钮高度应为 32px，实际 ${values.skillTargetButtonHeights.join("、") || "未渲染"}。` });
          if (values.clippedCells.length) failures.push({ rule: "table-cell-clipping", message: `表格文字被裁切且没有完整文本提示：${values.clippedCells.join("；")}` });
          if (values.scheduleTableMissingStandardScroll) failures.push({ rule: "table-scroll", message: "定时任务表格尚未接入 DataTable 的内部滚动区。" });
          if (values.tableCount && values.tables.some((table) => table.overflowY !== "auto" && table.overflowY !== "scroll")) {
            failures.push({ rule: "table-scroll", message: "表格滚动区的 overflow-y 不是 auto/scroll。" });
          }
          if (values.tables.some((table) => table.checkViewport && !table.bottomInViewport)) failures.push({ rule: "table-viewport", message: "表格滚动区底部超出窗口视口。" });
          if (!viewport.headerOnly && values.tables.some((table) => table.checkViewport && table.hasPagination && !table.paginationInViewport)) failures.push({ rule: "table-pagination-viewport", message: "表格分页栏未完整显示在窗口视口内。" });
          if (values.tables.some((table) => !table.hasPagination || !table.hasPageSizeControl)) {
            failures.push({ rule: "table-pagination", message: "表格没有分页条或每页条数控件。" });
          }
          if (values.inlineClickMisses.length) failures.push({ rule: "inline-hit-test", message: `行内控件被其他元素遮挡：${values.inlineClickMisses.join("；")}` });
        } catch (error) {
          failures.push({ rule: "route-load", message: asErrorMessage(error) });
        }
        const fileName = `${slug(route.name)}-${viewport.width}.png`;
        await page.screenshot({ path: path.join(shotsDir, fileName), fullPage: false }).catch((error: unknown) => {
          failures.push({ rule: "screenshot", message: asErrorMessage(error) });
        });
        if (!failures.some((failure) => failure.rule === "route-load")) failures.push(...await inspectTooltips(page));
        if (route.name === "products" && frameStatus === "strict" && metrics.dataSurfaceState === "table") {
          failures.push(...await inspectProductVariantSku(page));
        }
        for (const error of consoleErrors) failures.push({ rule: "console-error", message: error });
        reports.push({ route: route.path, routeName: route.name, viewport, heading, metrics, failures, consoleErrors, timeWarnings, sectionPageFindings, frameStatus });
        const state = failures.length ? `FAIL ${failures.length}` : frameStatus === "legacy" ? "LEGACY FRAME" : "PASS";
        const terminalState = typeof metrics.dataSurfaceState === "string" ? ` (${metrics.dataSurfaceState})` : "";
        console.log(`[${state}] ${route.path} @ ${viewport.width}×${viewport.height}${terminalState}`);
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    await server?.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    viewportSet: viewports,
    routeCount: new Set(reports.map(({ routeName }) => routeName)).size,
    checkCount: reports.length,
    failureCount: reports.reduce((count, item) => count + item.failures.length, 0) + stylePolicy.introduced.length,
    stylePolicy: {
      baselineVersion: styleBaselineFile.version,
      legacyFindingCount: stylePolicy.legacyCount,
      remainingBaselineCount: stylePolicy.remainingBaselineCount,
      failures: stylePolicy.introduced,
    },
    timeWarnings: [...allTimeWarnings].sort(),
    sectionPageBaselineVersion: sectionBaseline.version,
    sectionPageLegacyFindingCount: reports.reduce((count, item) => count + (item.sectionPageFindings?.filter((finding) => finding.legacy).length ?? 0), 0),
    frameBaselineVersion: frameBaseline.version,
    legacyFrameCheckCount: reports.filter((item) => item.frameStatus === "legacy").length,
    strictFrameCheckCount: reports.filter((item) => item.frameStatus === "strict").length,
    checks: reports,
  };
  await writeFile(path.join(shotsDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  const failures = reports.flatMap((item) => item.failures.map((failure) => ({ route: item.route, viewport: item.viewport.width, ...failure })));
  console.log(`ui:check complete: ${reports.length} route/viewport checks, ${report.strictFrameCheckCount} strict / ${report.legacyFrameCheckCount} legacy frame checks, ${failures.length} UI failures, ${stylePolicy.introduced.length} new style failure(s), ${stylePolicy.legacyCount} legacy style finding(s), ${report.sectionPageLegacyFindingCount} section-page baseline finding(s), ${allTimeWarnings.size} time warning(s).`);
  console.log(`Report: ${path.relative(uiRoot, path.join(shotsDir, "report.json"))}`);
  for (const failure of failures) console.error(`- ${failure.route} @ ${failure.viewport}: [${failure.rule}] ${failure.message}`);
  for (const finding of stylePolicy.introduced) console.error(`- ${finding.source}:${finding.line}: [${finding.rule}] ${finding.signature}`);
  for (const warning of allTimeWarnings) console.warn(`- [time-display-warning] ${warning}`);
  if (failures.length || stylePolicy.introduced.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`ui:check failed to start: ${asErrorMessage(error)}`);
  process.exitCode = 1;
});
