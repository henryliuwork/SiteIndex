import { join, resolve } from "node:path";

export interface RendererContentWindow {
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
}

export interface RendererContentOptions {
  mainDirectory: string;
  fallbackPath: string;
  devUiUrl: string;
}

export interface RendererContentRuntime {
  isPackaged: boolean;
  rendererUrl: string | undefined;
  resourcesPath: string;
}

function getFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadFallback(
  window: RendererContentWindow,
  fallbackPath: string,
  error: unknown,
): Promise<void> {
  const reason = getFailureReason(error);
  console.error(`SiteIndex 完整界面加载失败：${reason}`, error);
  await window.loadFile(fallbackPath, { query: { error: reason } });
}

export async function loadAppContent(
  window: RendererContentWindow,
  options: RendererContentOptions,
  runtime: RendererContentRuntime,
): Promise<void> {
  if (!runtime.isPackaged && runtime.rendererUrl !== undefined) {
    try {
      await window.loadURL(options.devUiUrl);
      return;
    } catch (error) {
      await loadFallback(window, options.fallbackPath, error);
      return;
    }
  }

  const uiIndex = runtime.isPackaged
    ? join(runtime.resourcesPath, "ui", "index.html")
    : resolve(options.mainDirectory, "../../../ui/dist/index.html");
  try {
    await window.loadFile(uiIndex);
  } catch (error) {
    await loadFallback(window, options.fallbackPath, error);
  }
}
