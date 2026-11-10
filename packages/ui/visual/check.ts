import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { classifyDataSurface, waitForDataSurface, type DataSurfaceState } from "./readiness";
import { isDataTableRoute } from "./routes";

type BrowserChannel = "msedge" | "chrome";

interface RouteCase {
  name: string;
  path: string;
  waitForDataSurface?: boolean;
}

interface Viewport {
  width: number;
  height: number;
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
}

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = path.join(uiRoot, ".shots");
const viewports: Viewport[] = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

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
      for (const step of ["url", "source", "brand", "done"]) {
        cases.push({ name: `new-project-${step}`, path: `/new/${step}` });
      }
    } else if (routePath === "*") {
      cases.push({ name: "not-found", path: "/__ui-check-not-found__" });
    } else {
      const path = routePath.replaceAll(":id", encodeURIComponent(projectId));
      cases.push({ name, path, waitForDataSurface: isDataTableRoute(path) });
    }
  }
  return cases;
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
  const channels: BrowserChannel[] = configured
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

async function readDataSurfaceState(page: Page): Promise<DataSurfaceState> {
  const snapshot = await page.evaluate(() => {
    const tableScrollVisible = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-table-scroll")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const paginationReady = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-pagination [aria-label='每页条数']")).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const hasVisibleRows = Array.from(document.querySelectorAll<HTMLElement>(".si-data-table")).some((table) => {
      const tableRect = table.getBoundingClientRect();
      let tableVisible = tableRect.width > 0 && tableRect.height > 0;
      for (let current: HTMLElement | null = table; tableVisible && current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") tableVisible = false;
      }
      return tableVisible && Array.from(table.querySelectorAll<HTMLElement>(".si-table tbody tr[data-row-id]")).some((row) => {
        const rect = row.getBoundingClientRect();
        let rowVisible = rect.width > 0 && rect.height > 0;
        for (let current: HTMLElement | null = row; rowVisible && current && current !== document.documentElement; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") rowVisible = false;
        }
        return rowVisible;
      });
    });
    const emptyElementVisible = Array.from(
      document.querySelectorAll<HTMLElement>(".si-data-table .si-table-empty, .si-page [data-table-empty], .si-content-blog-empty"),
    ).some((element) => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
      for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
    const mockRequestsPending = (window.__siteindexMockPendingRequests ?? 0) > 0;
    return {
      table: tableScrollVisible,
      pagination: paginationReady,
      empty: emptyElementVisible && !hasVisibleRows,
      error: Array.from(document.querySelectorAll<HTMLElement>(".si-page .si-api-error-state, main .si-api-error-state")).some((element) => {
        const rect = element.getBoundingClientRect();
        if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
        for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        return true;
      }),
      loading: mockRequestsPending || Array.from(
        document.querySelectorAll<HTMLElement>(".si-page-loading, .si-query-loading, .si-inventory-query-state, .si-content-blog-empty [role='status']"),
      ).some((element) => {
        const rect = element.getBoundingClientRect();
        if (!element.isConnected || element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return false;
        for (let current: HTMLElement | null = element; current && current !== document.documentElement; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        return true;
      }),
    };
  });
  return classifyDataSurface(snapshot);
}

async function waitForRoute(page: Page, route: RouteCase): Promise<DataSurfaceState | undefined> {
  await page.locator(".si-page, .si-placeholder").first().waitFor({ state: "visible", timeout: 20_000 });
  if (route.waitForDataSurface) {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    const state = await waitForDataSurface(() => readDataSurfaceState(page));
    await page.evaluate(() => document.fonts.ready);
    return state;
  }
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
  return undefined;
}

async function inspectPage(page: Page): Promise<{
  heading: string | null;
  metrics: Record<string, unknown>;
  styleWarnings: string[];
}> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const bodyStyle = getComputedStyle(document.body);
    const firstFont = bodyStyle.fontFamily.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
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
    const emptySurface = !hasVisibleRows && Array.from(document.querySelectorAll<HTMLElement>(".si-data-table .si-table-empty, .si-page [data-table-empty]")).some((element) => {
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

    const styleWarnings: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const node = sheet.ownerNode as HTMLElement | null;
      const source = node?.getAttribute("data-vite-dev-id") ?? node?.getAttribute("href") ?? sheet.href ?? "inline stylesheet";
      if (/tokens\.css(?:[?#]|$)/i.test(source)) continue;
      try {
        const css = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
        const colors = css.match(/(?:^|[;{}])\s*(?:color|background(?:-color)?|border(?:-[\w-]+)?-color|outline-color|fill|stroke)\s*:\s*(#[\da-f]{3,8}\b|rgba?\([^)]*\))/gim) ?? [];
        const fontSizes = css.match(/font-size\s*:\s*[\d.]+px\b/gim) ?? [];
        if (colors.length) styleWarnings.push(`${source}: 裸色值 ${colors.length} 处`);
        if (fontSizes.length) styleWarnings.push(`${source}: font-size 裸 px ${fontSizes.length} 处`);
      } catch {
        styleWarnings.push(`${source}: 无法读取样式表规则`);
      }
    }

    return {
      heading: document.querySelector("main h1")?.textContent?.trim() ?? null,
      metrics: {
        verticalOverflow,
        documentScrollHeight: root.scrollHeight,
        documentClientHeight: root.clientHeight,
        horizontalOverflow,
        documentScrollWidth: documentElement.scrollWidth,
        documentClientWidth: documentElement.clientWidth,
        bodyFontSize: bodyStyle.fontSize,
        bodyFontFamily: bodyStyle.fontFamily,
        bodyFirstFontIsGeist: /geist/i.test(firstFont),
        tableCount: tables.length,
        emptySurface,
        errorSurface,
        scheduleTableMissingStandardScroll: Boolean(document.querySelector(".si-schedules-page table")) && !tables.length,
        tables: tableMetrics,
        clippedCells: clippedCells.slice(0, 12),
        inlineClickTargetCount: clickTargets.length,
        inlineClickMisses: clickMisses,
      },
      styleWarnings: Array.from(new Set(styleWarnings)),
    };
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

async function main(): Promise<void> {
  await mkdir(shotsDir, { recursive: true });
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const reports: CheckReport[] = [];
  const allStyleWarnings = new Set<string>();

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

    console.log(`ui:check: ${routes.length} routes × ${viewports.length} viewports; project=${projectId}`);
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
        currentConsoleErrors = consoleErrors;
        try {
          await page.goto(`${baseUrl}/#${route.path}`, { waitUntil: "commit", timeout: 20_000 });
          const dataSurfaceState = await waitForRoute(page, route);
          const inspection = await inspectPage(page);
          heading = inspection.heading;
          metrics = dataSurfaceState ? { ...inspection.metrics, dataSurfaceState } : inspection.metrics;
          for (const warning of inspection.styleWarnings) allStyleWarnings.add(warning);

          const values = metrics as {
            verticalOverflow: boolean;
            horizontalOverflow: boolean;
            bodyFontSize: string;
            bodyFirstFontIsGeist: boolean;
            tableCount: number;
            emptySurface: boolean;
            errorSurface: boolean;
            scheduleTableMissingStandardScroll: boolean;
            tables: Array<{ overflowY: string; bottomInViewport: boolean; checkViewport: boolean; hasPagination: boolean; paginationBottom: number | null; paginationInViewport: boolean; hasPageSizeControl: boolean }>;
            clippedCells: string[];
            inlineClickMisses: string[];
            dataSurfaceState?: DataSurfaceState;
          };
          if (route.waitForDataSurface && values.dataSurfaceState === "table" && !values.tableCount) {
            failures.push({ rule: "table-readiness-mismatch", message: "就绪判定为表格已加载，但截图测量没有可见表格滚动区。" });
          }
          if (route.waitForDataSurface && values.dataSurfaceState === "empty" && !values.emptySurface) {
            failures.push({ rule: "table-readiness-mismatch", message: "就绪判定为空态，但截图测量没有可见空态。" });
          }
          if (route.waitForDataSurface && values.dataSurfaceState === "error" && !values.errorSurface) {
            failures.push({ rule: "table-readiness-mismatch", message: "就绪判定为错误态，但截图测量没有可见错误。" });
          }
          if (values.verticalOverflow) failures.push({ rule: "vertical-overflow", message: "窗口 document 有纵向滚动；内容应在应用内部滚动。" });
          if (values.horizontalOverflow) failures.push({ rule: "horizontal-overflow", message: "页面内容超出视口宽度。" });
          if (values.bodyFontSize !== "12px" || !values.bodyFirstFontIsGeist) {
            failures.push({ rule: "body-font", message: `正文要求 Geist 12px，实际为 ${values.bodyFontFamily ?? "unknown"} / ${values.bodyFontSize ?? "unknown"}。` });
          }
          if (values.clippedCells.length) failures.push({ rule: "table-cell-clipping", message: `表格文字被裁切且没有完整文本提示：${values.clippedCells.join("；")}` });
          if (values.scheduleTableMissingStandardScroll) failures.push({ rule: "table-scroll", message: "定时任务表格尚未接入 DataTable 的内部滚动区。" });
          if (values.tableCount && values.tables.some((table) => table.overflowY !== "auto" && table.overflowY !== "scroll")) {
            failures.push({ rule: "table-scroll", message: "表格滚动区的 overflow-y 不是 auto/scroll。" });
          }
          if (values.tables.some((table) => table.checkViewport && !table.bottomInViewport)) failures.push({ rule: "table-viewport", message: "表格滚动区底部超出窗口视口。" });
          if (values.tables.some((table) => table.checkViewport && table.hasPagination && !table.paginationInViewport)) failures.push({ rule: "table-pagination-viewport", message: "表格分页栏未完整显示在窗口视口内。" });
          if (values.tables.some((table) => !table.hasPagination || !table.hasPageSizeControl)) {
            failures.push({ rule: "table-pagination", message: "表格没有分页条或每页条数控件。" });
          }
          if (values.inlineClickMisses.length) failures.push({ rule: "inline-hit-test", message: `行内控件被其他元素遮挡：${values.inlineClickMisses.join("；")}` });
        } catch (error) {
          failures.push({ rule: "route-load", message: asErrorMessage(error) });
        }
        if (consoleErrors.length) {
          for (const error of consoleErrors) failures.push({ rule: "console-error", message: error });
        }

        const fileName = `${slug(route.name)}-${viewport.width}.png`;
        await page.screenshot({ path: path.join(shotsDir, fileName), fullPage: false }).catch((error: unknown) => {
          failures.push({ rule: "screenshot", message: asErrorMessage(error) });
        });
        reports.push({ route: route.path, routeName: route.name, viewport, heading, metrics, failures, consoleErrors });
        const state = failures.length ? `FAIL ${failures.length}` : "PASS";
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
    failureCount: reports.reduce((count, item) => count + item.failures.length, 0),
    styleWarnings: [...allStyleWarnings].sort(),
    checks: reports,
  };
  await writeFile(path.join(shotsDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  const failures = reports.flatMap((item) => item.failures.map((failure) => ({ route: item.route, viewport: item.viewport.width, ...failure })));
  console.log(`ui:check complete: ${reports.length} route/viewport checks, ${failures.length} failures, ${allStyleWarnings.size} stylesheet warning(s).`);
  console.log(`Report: ${path.relative(uiRoot, path.join(shotsDir, "report.json"))}`);
  for (const failure of failures) console.error(`- ${failure.route} @ ${failure.viewport}: [${failure.rule}] ${failure.message}`);
  if (failures.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`ui:check failed to start: ${asErrorMessage(error)}`);
  process.exitCode = 1;
});
