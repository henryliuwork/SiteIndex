// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import type { JobProgress, JobResult, SiteIndexApi } from "@siteindex/shared";
import { describe, expect, it, vi } from "vitest";
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

function createToast() {
  return {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
  };
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
    const demoToken = monitor.begin("demo", "虚构项目甲", ["DEMO-001"]);
    const otherToken = monitor.begin("other", "虚构项目乙", ["DEMO-002"]);

    disconnectFirst();
    expect(firstJobs.progressListeners.size).toBe(1);
    expect(firstJobs.finishedListeners.size).toBe(1);

    const disconnectSecond = monitor.connect(secondJobs.api, secondClient, secondToast);
    expect(firstJobs.progressListeners.size).toBe(0);
    expect(firstJobs.finishedListeners.size).toBe(0);
    expect(secondJobs.progressListeners.size).toBe(1);
    expect(secondJobs.finishedListeners.size).toBe(1);

    // 两个 prepare 响应都尚未返回；先交错送达事件，再反序关联 runId。
    secondJobs.emitProgress({ runId: "media-run-001", projectPath: "C:/fake/demo", job: "media", pct: 50, level: "info", message: "正在处理虚构 SKU", at: "2026-11-11T00:00:00.000Z" });
    secondJobs.emitProgress({ runId: "media-run-002", projectPath: "C:/fake/private-other", job: "media", pct: 75, level: "info", message: "正在复用虚构图片", at: "2026-11-11T00:00:01.000Z" });
    secondJobs.emitFinished({ runId: "media-run-002", job: "media", status: "partial", exitCode: 1, summary: "虚构权限问题", media_error_code: "WP_FORBIDDEN", media_results: [{ sku: "DEMO-002", status: "failed", reason: "虚构错误" }] });
    monitor.associate(otherToken, "media-run-002");
    monitor.associate(demoToken, "media-run-001");
    expect(secondToast.info.mock.calls).toEqual(expect.arrayContaining([
      ["图片处理进度（虚构项目甲）：正在处理虚构 SKU"], ["图片处理进度（虚构项目乙）：正在复用虚构图片"],
    ]));
    expect(monitor.getSnapshot("demo")?.progress).toBe("正在处理虚构 SKU");
    expect(monitor.getSnapshot("other")?.result?.media_results?.map(({ sku }) => sku)).toEqual(["DEMO-002"]);
    expect(firstToast.info).not.toHaveBeenCalled();
    secondJobs.emitFinished({ runId: "media-run-001", job: "media", status: "ok", exitCode: 0, summary: "图片准备完成", media_results: [{ sku: "DEMO-001", status: "uploaded" }] });
    expect(secondToast.error).toHaveBeenCalledWith("项目「虚构项目乙」 WordPress 权限不足（403），媒体批次已停止。");
    expect(secondToast.success).toHaveBeenCalledWith("项目「虚构项目甲」 图片 URL 处理完成。");
    await vi.waitFor(() => expect(secondInvalidate).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] }));
    const invalidatedKeys = secondInvalidate.mock.calls.map(([options]) => options?.queryKey);
    expect(invalidatedKeys).toEqual(expect.arrayContaining([
      ["edm", "images", "other"], ["edm", "summary", "demo"], ["edm", "summary", "other"],
      ["job-history", "demo"], ["job-history", "other"],
    ]));
    expect(monitor.getSnapshot("demo")?.result?.media_results?.map(({ sku }) => sku)).toEqual(["DEMO-001"]);
    expect(monitor.getSnapshot("other")?.result?.media_results?.map(({ sku }) => sku)).toEqual(["DEMO-002"]);
    expect(JSON.stringify([secondToast.info.mock.calls, secondToast.success.mock.calls, secondToast.error.mock.calls])).not.toContain("C:/fake");
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
    const token = monitor.begin("demo", "虚构项目", ["DEMO-001"]);
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
