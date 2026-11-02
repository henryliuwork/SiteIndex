import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppContent, type RendererContentWindow } from "./renderer-loader.js";

const options = {
  mainDirectory: "/app/out/main",
  fallbackPath: "/app/out/renderer/fallback.html",
  devUiUrl: "http://localhost:5174",
};

function createWindow() {
  return {
    loadURL: vi.fn(async (_url: string) => undefined),
    loadFile: vi.fn(async (_filePath: string, _options?: { query?: Record<string, string> }) => undefined),
  } satisfies RendererContentWindow & {
    loadURL: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
  };
}

describe("renderer content loading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the packaged UI resources even when ELECTRON_RENDERER_URL is set", async () => {
    const window = createWindow();
    const resourcesPath = "/app/resources";

    await loadAppContent(window, options, {
      isPackaged: true,
      rendererUrl: "http://localhost:5174",
      resourcesPath,
    });

    expect(window.loadURL).not.toHaveBeenCalled();
    expect(window.loadFile).toHaveBeenCalledTimes(1);
    expect(window.loadFile).toHaveBeenCalledWith(join(resourcesPath, "ui", "index.html"));
  });

  it("uses the development URL only for an unpackaged app", async () => {
    const window = createWindow();

    await loadAppContent(window, options, {
      isPackaged: false,
      rendererUrl: "http://localhost:5174",
      resourcesPath: "/app/resources",
    });

    expect(window.loadURL).toHaveBeenCalledTimes(1);
    expect(window.loadURL).toHaveBeenCalledWith(options.devUiUrl);
    expect(window.loadFile).not.toHaveBeenCalled();
  });

  it("logs a development load failure and passes its reason to the fallback page", async () => {
    const window = createWindow();
    const error = new Error("dev renderer unavailable");
    window.loadURL.mockRejectedValueOnce(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await loadAppContent(window, options, {
      isPackaged: false,
      rendererUrl: "http://localhost:5174",
      resourcesPath: "/app/resources",
    });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(`SiteIndex 完整界面加载失败：${error.message}`, error);
    expect(window.loadFile).toHaveBeenCalledTimes(1);
    expect(window.loadFile).toHaveBeenCalledWith(options.fallbackPath, {
      query: { error: error.message },
    });
  });

  it("logs a packaged UI load failure and passes its reason to the fallback page", async () => {
    const window = createWindow();
    const error = new Error("packaged UI missing");
    window.loadFile.mockRejectedValueOnce(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await loadAppContent(window, options, {
      isPackaged: true,
      rendererUrl: "http://localhost:5174",
      resourcesPath: "/app/resources",
    });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(`SiteIndex 完整界面加载失败：${error.message}`, error);
    expect(window.loadFile).toHaveBeenNthCalledWith(2, options.fallbackPath, {
      query: { error: error.message },
    });
  });

  it("shows the fallback failure reason as text", async () => {
    const errorElement = { textContent: "", hidden: true };
    vi.stubGlobal("window", { location: { search: "?error=renderer+failed+%3Ctag%3E" } });
    vi.stubGlobal("document", { querySelector: () => errorElement });
    vi.resetModules();

    await import("../renderer/fallback.js");

    expect(errorElement.textContent).toBe("完整界面加载失败：renderer failed <tag>");
    expect(errorElement.hidden).toBe(false);
  });
});
