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
  appPath: string;
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
    if (runtime.isPackaged) {
      const asarUiIndex = join(runtime.appPath, "build-resources", "ui", "index.html");
      try {
        console.warn("外部 UI 资源加载失败，改用 app.asar 中的界面副本。", error);
        await window.loadFile(asarUiIndex);
        return;
      } catch (asarError) {
        await loadFallback(
          window,
          options.fallbackPath,
          new Error(
            `resources/ui/index.html: ${getFailureReason(error)}; app.asar UI: ${getFailureReason(asarError)}`,
          ),
        );
        return;
      }
    }
    await loadFallback(window, options.fallbackPath, error);
  }
}
