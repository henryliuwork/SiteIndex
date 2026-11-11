// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import type { JobProgress, JobResult, SiteIndexApi } from "@siteindex/shared";
import { describe, expect, it, vi } from "vitest";
import type { ToastApi } from "../../components/overlays";
import { createEdmMediaJobMonitor } from "./media-job-monitor";

type JobsApi = Pick<SiteIndexApi["jobs"], "onProgress" | "onFinished">;

function createJobsApi() {
  const progressListeners = new Set<(event: JobProgress) => void>();
  const finishedListeners = new Set<(event: JobResult) => void>();
  const api: JobsApi = {
    onProgress: (listener) => { progressListeners.add(listener); return () => progressListeners.delete(listener); },
    onFinished: (listener) => { finishedListeners.add(listener); return () => finishedListeners.delete(listener); },
  };
  return {
    api,
    progressListeners,
    finishedListeners,
    emitProgress: (event: JobProgress) => progressListeners.forEach((listener) => listener(event)),
    emitFinished: (event: JobResult) => finishedListeners.forEach((listener) => listener(event)),
  };
}

function createToast(): ToastApi {
  return { success: vi.fn(), error: vi.fn(), info: vi.fn() };
}

describe("EDM media job monitor lifecycle", () => {
  it("rebinds to the current API and app contexts without duplicate listeners", async () => {
    const monitor = createEdmMediaJobMonitor();
    const firstJobs = createJobsApi();
    const secondJobs = createJobsApi();
    const firstClient = new QueryClient();
    const secondClient = new QueryClient();
    const firstInvalidate = vi.spyOn(firstClient, "invalidateQueries");
    const secondInvalidate = vi.spyOn(secondClient, "invalidateQueries");
    const firstToast = createToast();
    const secondToast = createToast();
    const disconnectFirst = monitor.connect(firstJobs.api, firstClient, firstToast);
    const token = monitor.begin("demo", ["DEMO-001"]);
    monitor.associate(token, "media-run-001");

    disconnectFirst();
    expect(firstJobs.progressListeners.size).toBe(1);
    expect(firstJobs.finishedListeners.size).toBe(1);

    const disconnectSecond = monitor.connect(secondJobs.api, secondClient, secondToast);
    expect(firstJobs.progressListeners.size).toBe(0);
    expect(firstJobs.finishedListeners.size).toBe(0);
    expect(secondJobs.progressListeners.size).toBe(1);
    expect(secondJobs.finishedListeners.size).toBe(1);

    secondJobs.emitProgress({ runId: "media-run-001", projectPath: "C:/fake/demo", job: "media", pct: 50, level: "info", message: "正在处理虚构 SKU", at: "2026-11-11T00:00:00.000Z" });
    expect(secondToast.info).toHaveBeenCalledWith("图片处理进度：正在处理虚构 SKU");
    expect(firstToast.info).not.toHaveBeenCalled();
    secondJobs.emitFinished({ runId: "media-run-001", job: "media", status: "ok", exitCode: 0, summary: "图片准备完成", media_results: [{ sku: "DEMO-001", status: "uploaded" }] });
    expect(secondToast.success).toHaveBeenCalledWith("图片 URL 处理完成。");
    expect(firstToast.success).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(secondInvalidate).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] }));
    expect(secondInvalidate).toHaveBeenCalledWith({ queryKey: ["edm", "summary", "demo"] });
    expect(secondInvalidate).toHaveBeenCalledWith({ queryKey: ["job-history", "demo"] });
    expect(firstInvalidate).not.toHaveBeenCalled();

    disconnectSecond();
    expect(secondJobs.progressListeners.size).toBe(0);
    expect(secondJobs.finishedListeners.size).toBe(0);

    const disconnectRemount = monitor.connect(secondJobs.api, secondClient, secondToast);
    expect(secondJobs.progressListeners.size).toBe(1);
    expect(secondJobs.finishedListeners.size).toBe(1);
    disconnectRemount();
    expect(secondJobs.progressListeners.size).toBe(0);
    expect(secondJobs.finishedListeners.size).toBe(0);
    firstClient.clear();
    secondClient.clear();
  });

  it("window teardown drops active subscriptions and does not retain a false running snapshot", () => {
    const monitor = createEdmMediaJobMonitor();
    const firstJobs = createJobsApi();
    const firstClient = new QueryClient();
    const disconnect = monitor.connect(firstJobs.api, firstClient, createToast());
    const token = monitor.begin("demo", ["DEMO-001"]);
    monitor.associate(token, "media-run-window");

    window.dispatchEvent(new Event("pagehide"));

    expect(firstJobs.progressListeners.size).toBe(0);
    expect(firstJobs.finishedListeners.size).toBe(0);
    expect(monitor.getSnapshot("demo")).toBeNull();

    disconnect();
    const recreatedJobs = createJobsApi();
    const disconnectAfterRecreate = monitor.connect(recreatedJobs.api, firstClient, createToast());
    expect(recreatedJobs.progressListeners.size).toBe(1);
    expect(recreatedJobs.finishedListeners.size).toBe(1);
    disconnectAfterRecreate();
    expect(recreatedJobs.progressListeners.size).toBe(0);
    expect(recreatedJobs.finishedListeners.size).toBe(0);
    firstClient.clear();
  });
});
