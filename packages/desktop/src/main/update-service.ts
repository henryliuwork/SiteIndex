import type { UpdateStatus } from "@siteindex/shared";
import type { AppUpdater, UpdateInfo } from "electron-updater";

const RELEASE_URL = "https://github.com/henryliuwork/SiteIndex/releases/latest";
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateServiceOptions {
  updater: AppUpdater;
  currentVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  waitForJobs(): Promise<void>;
  resumeJobs(): void;
  beforeInstall(): void;
  installFailed(): void;
  emitStatus(status: UpdateStatus): void;
}

function releaseNotes(info: UpdateInfo): string | undefined {
  return typeof info.releaseNotes === "string" ? info.releaseNotes : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateService(options: UpdateServiceOptions) {
  const { updater } = options;
  updater.allowPrerelease = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  const unsupported = options.platform !== "win32" || !options.isPackaged;
  let status: UpdateStatus = unsupported
    ? { state: "unsupported", current: options.currentVersion, manual_url: RELEASE_URL }
    : { state: "idle", current: options.currentVersion };
  let firstCheckAt = Date.now() + FIRST_CHECK_DELAY_MS;
  let checkPromise: Promise<UpdateStatus> | null = null;
  let downloadPromise: Promise<void> | null = null;
  let installPromise: Promise<void> | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  const publish = (next: UpdateStatus): UpdateStatus => {
    status = next;
    options.emitStatus(status);
    return status;
  };
  const fail = (error: unknown): UpdateStatus =>
    publish({
      state: "error",
      current: options.currentVersion,
      latest: status.latest,
      notes: status.notes,
      error: errorMessage(error),
      manual_url: RELEASE_URL,
    });

  if (!unsupported) {
    updater.on("checking-for-update", () => {
      if (status.state !== "ready" && status.state !== "downloading") publish({ ...status, state: "checking" });
    });
    updater.on("update-available", (info) => {
      publish({
        state: "available",
        current: options.currentVersion,
        latest: info.version,
        notes: releaseNotes(info),
        manual_url: RELEASE_URL,
      });
    });
    updater.on("update-not-available", (info) => {
      publish({ state: "idle", current: options.currentVersion, latest: info.version });
    });
    updater.on("download-progress", (progress) => {
      publish({ ...status, state: "downloading", percent: Math.max(0, Math.min(100, progress.percent)) });
    });
    updater.on("update-downloaded", (info) => {
      publish({
        state: "ready",
        current: options.currentVersion,
        latest: info.version,
        notes: releaseNotes(info) ?? status.notes,
        percent: 100,
        manual_url: RELEASE_URL,
      });
    });
    updater.on("error", (error) => {
      fail(error);
    });
  }

  async function check(): Promise<UpdateStatus> {
    if (unsupported || status.state === "ready" || status.state === "downloading") return status;
    if (checkPromise) return checkPromise;
    checkPromise = (async () => {
      const delay = firstCheckAt - Date.now();
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      publish({ ...status, state: "checking", error: undefined });
      try {
        const result = await updater.checkForUpdates();
        if (!result) return publish({ state: "unsupported", current: options.currentVersion, manual_url: RELEASE_URL });
        if (result.isUpdateAvailable && status.state === "checking") {
          return publish({
            state: "available",
            current: options.currentVersion,
            latest: result.updateInfo.version,
            notes: releaseNotes(result.updateInfo),
            manual_url: RELEASE_URL,
          });
        }
        if (!result.isUpdateAvailable && status.state === "checking")
          return publish({ state: "idle", current: options.currentVersion, latest: result.updateInfo.version });
        return status;
      } catch (error) {
        return fail(error);
      }
    })().finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  }

  async function download(): Promise<void> {
    if (downloadPromise) return downloadPromise;
    if (status.state !== "available") throw new Error("当前没有可下载的更新。");
    downloadPromise = (async () => {
      publish({ ...status, state: "downloading", percent: 0 });
      try {
        await updater.downloadUpdate();
        if (status.state === "downloading") publish({ ...status, state: "ready", percent: 100 });
      } catch (error) {
        fail(error);
        throw error;
      }
    })().finally(() => {
      downloadPromise = null;
    });
    return downloadPromise;
  }

  function install(): Promise<void> {
    if (installPromise) return installPromise;
    if (status.state !== "ready") return Promise.reject(new Error("更新尚未下载完成。"));
    installPromise = (async () => {
      try {
        await options.waitForJobs();
        options.beforeInstall();
        updater.quitAndInstall(false, true);
      } catch (error) {
        options.resumeJobs();
        options.installFailed();
        installPromise = null;
        fail(error);
        throw error;
      }
    })();
    return installPromise;
  }

  return {
    check,
    download,
    install,
    getStatus: () => status,
    start(): void {
      if (firstTimer || intervalTimer) return;
      firstCheckAt = Date.now() + FIRST_CHECK_DELAY_MS;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        void check();
      }, FIRST_CHECK_DELAY_MS);
      intervalTimer = setInterval(() => {
        void check();
      }, CHECK_INTERVAL_MS);
    },
    stop(): void {
      if (firstTimer) clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      firstTimer = null;
      intervalTimer = null;
    },
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
