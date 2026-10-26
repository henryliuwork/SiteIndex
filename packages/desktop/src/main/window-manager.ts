import { app, BrowserWindow, screen, session, shell } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowManagerOptions {
  mainDirectory: string;
  fallbackPath: string;
  devUiUrl: string;
  initiallyHidden: boolean;
  shouldHideOnClose: () => boolean;
  isShuttingDown: () => boolean;
}

export function createWindowManager(options: WindowManagerOptions) {
  let mainWindow: BrowserWindow | null = null;
  let launchHidden = options.initiallyHidden;

  function sendToWindows(channel: string, payload: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  function trackMainWindow(window: BrowserWindow): void {
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
  }

  function showMainWindow(): void {
    launchHidden = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      return;
    }
    void createMainWindow().then((window) => {
      window.show();
      window.focus();
    });
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
      const visible = screen.getAllDisplays().some(({ workArea }) =>
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
      const candidate = new URL(options.devUiUrl);
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
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
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
        return !app.isPackaged && target.origin === new URL(options.devUiUrl).origin;
      }
      const uiIndex = app.isPackaged
        ? join(process.resourcesPath, "ui", "index.html")
        : resolve(options.mainDirectory, "../../../ui/dist/index.html");
      return fileURLToPath(target).toLowerCase() === uiIndex.toLowerCase();
    } catch {
      return false;
    }
  }

  async function loadAppContent(window: BrowserWindow): Promise<void> {
    if (process.env.ELECTRON_RENDERER_URL !== undefined) {
      try {
        await window.loadURL(options.devUiUrl);
        return;
      } catch {
        await window.loadFile(options.fallbackPath);
        return;
      }
    }

    const uiIndex = app.isPackaged
      ? join(process.resourcesPath, "ui", "index.html")
      : resolve(options.mainDirectory, "../../../ui/dist/index.html");
    try {
      await window.loadFile(uiIndex);
    } catch {
      await window.loadFile(options.fallbackPath);
    }
  }

  async function createMainWindow(): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      ...readWindowBounds(),
      minWidth: 1100,
      minHeight: 720,
      show: false,
      title: "SiteIndex",
      backgroundColor: "#FFFFFF",
      titleBarStyle: process.platform === "win32" ? "hidden" : "hiddenInset",
      ...(process.platform === "win32"
        ? { titleBarOverlay: { color: "#FFFFFF", symbolColor: "#1B1F24", height: 38 } }
        : {}),
      webPreferences: {
        preload: join(options.mainDirectory, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow = window;
    trackMainWindow(window);

    window.once("ready-to-show", () => {
      if (launchHidden) window.hide();
      else window.show();
    });
    window.on("close", (event) => {
      saveWindowBounds(window);
      if (options.shouldHideOnClose() && !options.isShuttingDown()) {
        event.preventDefault();
        window.hide();
      }
    });
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

  return {
    createMainWindow,
    getMainWindow: () => mainWindow,
    registerContentSecurityPolicy,
    sendToWindows,
    showMainWindow,
  };
}
