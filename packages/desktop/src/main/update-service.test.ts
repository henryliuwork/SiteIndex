import { EventEmitter } from "node:events";
import type { AppUpdater } from "electron-updater";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateService } from "./update-service.js";

class FakeUpdater extends EventEmitter {
  allowPrerelease = true;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: "0.1.0" } }));
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

function serviceFor(
  updater: FakeUpdater,
  options: { platform?: NodeJS.Platform; waitForJobs?: () => Promise<void> } = {},
) {
  const beforeInstall = vi.fn();
  const resumeJobs = vi.fn();
  const emitStatus = vi.fn();
  const service = createUpdateService({
    updater: updater as unknown as AppUpdater,
    currentVersion: "0.1.0",
    platform: options.platform ?? "win32",
    isPackaged: true,
    waitForJobs: options.waitForJobs ?? (async () => undefined),
    resumeJobs,
    beforeInstall,
    installFailed: vi.fn(),
    emitStatus,
  });
  return { service, beforeInstall, resumeJobs, emitStatus };
}

afterEach(() => vi.useRealTimers());

describe("desktop auto update", () => {
  it("checks after ten seconds, then every six hours, without auto-downloading", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const { service } = serviceFor(updater);
    service.start();
    const firstCheck = service.check(); // Renderer may request a check as soon as it mounts.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await firstCheck;
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("waits for the active Job before starting installation", async () => {
    const updater = new FakeUpdater();
    let finishJob!: () => void;
    const waitForJobs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishJob = resolve;
        }),
    );
    const { service, beforeInstall } = serviceFor(updater, { waitForJobs });
    updater.emit("update-downloaded", { version: "0.1.1" });
    const installing = service.install();
    expect(waitForJobs).toHaveBeenCalledOnce();
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    finishJob();
    await installing;
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("returns a manual Release URL on unsigned macOS", async () => {
    const updater = new FakeUpdater();
    const { service } = serviceFor(updater, { platform: "darwin" });
    await expect(service.check()).resolves.toMatchObject({
      state: "unsupported",
      current: "0.1.0",
      manual_url: "https://github.com/henryliuwork/SiteIndex/releases/latest",
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await expect(service.download()).rejects.toThrow();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
});
