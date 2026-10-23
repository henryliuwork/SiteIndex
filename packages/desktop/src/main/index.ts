import { app, BrowserWindow, screen, session, shell, utilityProcess } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreService, type CoreService } from "@siteindex/core";
import { EXIT, type AppSettings, type ProjectId } from "@siteindex/shared";
import { chooseDirectory, registerIpcHandlers } from "./ipc.js";
import { createJobManager } from "./job-manager.js";
import { showJobNotification } from "./notifications.js";
import { createProjectCatalog, type ProjectCatalog } from "./project-catalog.js";
import { parseRunJobArguments } from "./run-job-args.js";
import { createDesktopIntegrations } from "./desktop-integrations.js";
import { createSettingsStore } from "./settings-store.js";
import { createUiStateStore } from "./ui-state-store.js";

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const isRunJob = process.argv.includes("--run-job");
const hasSingleInstanceLock = isRunJob || app.requestSingleInstanceLock();
const mainDirectory = dirname(fileURLToPath(import.meta.url));
const fallbackPath = resolve(mainDirectory, "../renderer/fallback.html");
const devUiUrl = process.env.SITEINDEX_UI_URL ?? "http://localhost:5173";
let mainWindow: BrowserWindow | null = null;
let projectCatalog: ProjectCatalog | null = null;
let isShuttingDown = false;

if (process.platform === "win32") app.setAppUserModelId("com.siteindex.desktop");

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (isRunJob || !mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const settingsStore = createSettingsStore(join(app.getPath("appData"), "SiteIndex"));
    const jobs = createJobManager({
      workerPath: join(mainDirectory, "job-worker.js"),
      getSettings: () => settingsStore.get(),
      resolveProject: (id: ProjectId) => {
        if (!projectCatalog) throw { code: "PROJECT_NOT_FOUND", message: "项目目录尚未就绪。", detail: id };
        return projectCatalog.resolveProject(id);
      },
      fork: (modulePath) => utilityProcess.fork(modulePath),
      emitProgress: (progress) => sendToWindows("si:jobs.onProgress", progress),
      emitFinished: (result) => sendToWindows("si:jobs.onFinished", result),
      notify: showJobNotification,
    });
    const desktopIntegrations = createDesktopIntegrations({
      executablePath: app.getPath("exe"),
      resourcesDirectory: process.resourcesPath,
      isPackaged: app.isPackaged,
    });
    app.on("before-quit", (event) => {
      if ((jobs.activeCount === 0 && !projectCatalog) || isShuttingDown) return;
      event.preventDefault();
      isShuttingDown = true;
      void Promise.all([jobs.shutdown(), projectCatalog?.close()]).finally(() => {
        projectCatalog = null;
        app.quit();
      });
    });

    if (isRunJob) {
      const args = parseRunJobArguments(process.argv);
      if (!args) {
        app.exit(EXIT.BAD_ARGS);
        return;
      }
      try {
        const result = await jobs.runAndWait({ projectPath: resolve(args.projectPath), job: args.job }, "schedule");
        app.exit(result.exitCode);
      } catch (error) {
        process.stderr.write(`SiteIndex Job 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
        app.exit(EXIT.BAD_ARGS);
      }
      return;
    }

    const isFirstRun = !(await settingsStore.exists());
    let currentSettings = await settingsStore.get();
    if (isFirstRun) {
      const projectsRoot = await chooseDirectory();
      if (projectsRoot) currentSettings = await settingsStore.set({ projects_root: projectsRoot });
    }

    let core: CoreService | null = null;
    const catalog = createProjectCatalog(
      (projectPath) => core?.invalidate(projectPath),
      (id) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send("si:projects.onChanged", id);
        }
      },
    );
    projectCatalog = catalog;
    const coreService = createCoreService({
      resolveProject: catalog.resolveProject,
      get deviceId() {
        return currentSettings.device_id;
      },
      get deviceName() {
        return currentSettings.device_name;
      },
      get cacheDir() {
        return currentSettings.cache_dir;
      },
      templateDir: app.isPackaged
        ? join(process.resourcesPath, "templates", "project")
        : resolve(mainDirectory, "../../../../templates/project"),
    });
    core = coreService;
    await catalog.refresh(currentSettings);
    registerIpcHandlers(
      settingsStore,
      createUiStateStore(async () => (await settingsStore.get()).cache_dir),
      coreService,
      catalog,
      async (updated) => {
        const projectsChanged =
          currentSettings.projects_root !== updated.projects_root ||
          currentSettings.extra_projects.length !== updated.extra_projects.length ||
          currentSettings.extra_projects.some((entry, index) => entry !== updated.extra_projects[index]);
        currentSettings = updated;
        if (projectsChanged) await catalog.refresh(currentSettings);
      },
      jobs,
      desktopIntegrations,
    );

    registerContentSecurityPolicy();
    mainWindow = await createMainWindow();
    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow().then((window) => {
          mainWindow = window;
          mainWindow.on("closed", () => {
            mainWindow = null;
          });
        });
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function sendToWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readWindowBounds(): WindowBounds {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isRecord(parsed)) return { width: 1200, height: 800 };

    const width = typeof parsed.width === "number" ? Math.max(1100, parsed.width) : 1200;
    const height = typeof parsed.height === "number" ? Math.max(720, parsed.height) : 800;
    const x = typeof parsed.x === "number" ? parsed.x : undefined;
    const y = typeof parsed.y === "number" ? parsed.y : undefined;
    const bounds: WindowBounds = {
      width,
      height,
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
    };
    const visible = screen
      .getAllDisplays()
      .some(({ workArea }) =>
        bounds.x !== undefined && bounds.y !== undefined
          ? bounds.x < workArea.x + workArea.width - 100 &&
            bounds.x + bounds.width > workArea.x + 100 &&
            bounds.y < workArea.y + workArea.height - 100 &&
            bounds.y + bounds.height > workArea.y + 100
          : true,
      );
    return visible ? bounds : { width, height };
  } catch {
    return { width: 1200, height: 800 };
  }
}

function saveWindowBounds(window: BrowserWindow): void {
  const { x, y, width, height } = window.getBounds();
  writeFileSync(join(app.getPath("userData"), "window-state.json"), JSON.stringify({ x, y, width, height }), "utf8");
}

function registerContentSecurityPolicy(): void {
  let parsedDevUrl: URL;
  try {
    const candidate = new URL(devUiUrl);
    parsedDevUrl =
      candidate.protocol === "http:" || candidate.protocol === "https:" ? candidate : new URL("http://localhost:5173");
  } catch {
    parsedDevUrl = new URL("http://localhost:5173");
  }
  const websocketOrigin = parsedDevUrl.origin.replace(/^http/, "ws");
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${parsedDevUrl.origin} ${websocketOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isAppUrl(value: string): boolean {
  try {
    const target = new URL(value);
    if (target.protocol !== "file:") {
      return !app.isPackaged && target.origin === new URL(devUiUrl).origin;
    }
    const uiIndex = app.isPackaged
      ? join(process.resourcesPath, "ui", "index.html")
      : resolve(mainDirectory, "../../../ui/dist/index.html");
    return fileURLToPath(target).toLowerCase() === uiIndex.toLowerCase();
  } catch {
    return false;
  }
}

async function loadAppContent(window: BrowserWindow): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    try {
      await window.loadURL(devUiUrl);
      return;
    } catch {
      await window.loadFile(fallbackPath);
      return;
    }
  }

  const uiIndex = app.isPackaged
    ? join(process.resourcesPath, "ui", "index.html")
    : resolve(mainDirectory, "../../../ui/dist/index.html");
  try {
    await window.loadFile(uiIndex);
  } catch {
    await window.loadFile(fallbackPath);
  }
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...readWindowBounds(),
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: "SiteIndex",
    backgroundColor: "#f6f7f5",
    titleBarStyle: process.platform === "win32" ? "hidden" : "hiddenInset",
    ...(process.platform === "win32"
      ? { titleBarOverlay: { color: "#f6f7f5", symbolColor: "#24332d", height: 38 } }
      : {}),
    webPreferences: {
      preload: join(mainDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", () => saveWindowBounds(window));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) void shell.openExternal(url);
  });

  await loadAppContent(window);
  return window;
}
