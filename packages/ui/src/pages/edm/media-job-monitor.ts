import type { JobProgress, JobResult, SiteIndexApi } from "@siteindex/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { ToastApi } from "../../components/overlays";

export interface EdmMediaRunSnapshot {
  projectId: string;
  projectName: string;
  skus: string[];
  state: "starting" | "running" | "finished" | "failed";
  runId?: string;
  progress: string;
  result?: JobResult;
  error?: string;
}

interface MediaRunContext {
  projectId: string;
  projectName: string;
  skus: string[];
}

type JobsApi = Pick<SiteIndexApi["jobs"], "onProgress" | "onFinished">;

export interface EdmMediaJobMonitor {
  connect: (jobs: JobsApi, queryClient: QueryClient, toast: ToastApi) => () => void;
  begin: (projectId: string, projectName: string, skus: string[]) => symbol;
  associate: (token: symbol, runId: string) => void;
  fail: (token: symbol, message: string) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: (projectId: string) => EdmMediaRunSnapshot | null;
}

export function createEdmMediaJobMonitor(): EdmMediaJobMonitor {
  const snapshots = new Map<string, EdmMediaRunSnapshot>();
  const listeners = new Set<() => void>();
  const consumers = new Set<symbol>();
  const pendingStarts = new Map<symbol, EdmMediaRunSnapshot>();
  const contextsByRunId = new Map<string, MediaRunContext>();
  const earlyProgress = new Map<string, JobProgress>();
  const earlyResults = new Map<string, JobResult>();
  const progressToastAt = new Map<string, number>();
  let activeQueryClient: QueryClient | undefined;
  let activeToast: ToastApi | undefined;
  let subscribedJobs: JobsApi | undefined;
  let stopProgress: (() => void) | undefined;
  let stopFinished: (() => void) | undefined;

  const publish = () => { for (const listener of listeners) listener(); };

  function rememberRecent<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > 20) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) return;
      cache.delete(oldestKey);
    }
  }

  function hasActiveRuns(): boolean {
    return pendingStarts.size > 0 || contextsByRunId.size > 0;
  }

  function unbindJobs(): void {
    stopProgress?.();
    stopFinished?.();
    stopProgress = undefined;
    stopFinished = undefined;
    subscribedJobs = undefined;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
  }

  function releaseIfIdle(): void {
    if (consumers.size > 0 || hasActiveRuns()) return;
    unbindJobs();
    activeQueryClient = undefined;
    activeToast = undefined;
    earlyProgress.clear();
    earlyResults.clear();
    progressToastAt.clear();
  }

  function invalidateMediaQueries(projectId: string): void {
    if (!activeQueryClient) return;
    void Promise.all([
      activeQueryClient.invalidateQueries({ queryKey: ["edm", "images", projectId] }),
      activeQueryClient.invalidateQueries({ queryKey: ["edm", "summary", projectId] }),
      activeQueryClient.invalidateQueries({ queryKey: ["job-history", projectId] }),
    ]).catch(() => undefined);
  }

  function notifyFinished(result: JobResult, projectName: string): void {
    const source = `项目「${projectName}」`;
    if (result.media_error_code === "WP_AUTH_FAILED") activeToast?.error(`${source} WordPress 认证失败（401），媒体批次已停止。`);
    else if (result.media_error_code === "WP_FORBIDDEN") activeToast?.error(`${source} WordPress 权限不足（403），媒体批次已停止。`);
    else if (result.status === "ok") activeToast?.success(`${source} 图片 URL 处理完成。`);
    else if (result.status === "partial") activeToast?.info(`${source} 图片 URL 已部分处理，请检查逐 SKU 结果。`);
    else activeToast?.error(`${source} ${result.summary || "图片 URL 处理失败。"}`);
  }

  function handleProgress(progress: JobProgress): void {
    if (progress.job !== "media") return;
    const context = contextsByRunId.get(progress.runId);
    if (!context) {
      rememberRecent(earlyProgress, progress.runId, progress);
      return;
    }

    const current = snapshots.get(context.projectId);
    if (current?.runId !== progress.runId || current.state === "finished" || current.state === "failed") return;
    snapshots.set(context.projectId, { ...current, state: "running", progress: progress.message });
    publish();

    const now = Date.now();
    if (now - (progressToastAt.get(progress.runId) ?? 0) >= 2_800) {
      activeToast?.info(`图片处理进度（${context.projectName}）：${progress.message}`);
      progressToastAt.set(progress.runId, now);
    }
  }

  function handleFinished(result: JobResult, context: MediaRunContext): void {
    const current = snapshots.get(context.projectId);
    if (current?.runId === result.runId) {
      snapshots.set(context.projectId, { ...current, state: "finished", progress: "", result });
      publish();
    }

    notifyFinished(result, context.projectName);
    invalidateMediaQueries(context.projectId);
    contextsByRunId.delete(result.runId);
    progressToastAt.delete(result.runId);
    earlyProgress.delete(result.runId);
    earlyResults.delete(result.runId);
    releaseIfIdle();
  }

  function handleResult(result: JobResult): void {
    if (result.job !== "media") return;
    const context = contextsByRunId.get(result.runId);
    if (!context) {
      rememberRecent(earlyResults, result.runId, result);
      return;
    }
    handleFinished(result, context);
  }

  function onPageHide(): void {
    // Renderer 即将销毁时，主动解开 Electron IPC 与 React 上下文的引用。
    const closingProjectIds = new Set([
      ...[...pendingStarts.values()].map(({ projectId }) => projectId),
      ...[...contextsByRunId.values()].map(({ projectId }) => projectId),
    ]);
    unbindJobs();
    consumers.clear();
    pendingStarts.clear();
    contextsByRunId.clear();
    activeQueryClient = undefined;
    activeToast = undefined;
    earlyProgress.clear();
    earlyResults.clear();
    progressToastAt.clear();
    for (const projectId of closingProjectIds) {
      const snapshot = snapshots.get(projectId);
      if (snapshot?.state === "starting" || snapshot?.state === "running") snapshots.delete(projectId);
    }
    publish();
  }

  function bindJobs(jobs: JobsApi): void {
    if (subscribedJobs === jobs) return;
    unbindJobs();
    subscribedJobs = jobs;
    stopProgress = jobs.onProgress(handleProgress);
    stopFinished = jobs.onFinished(handleResult);
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
  }

  return {
    connect(jobs, queryClient, toast) {
      activeQueryClient = queryClient;
      activeToast = toast;
      const consumer = Symbol("edm-page");
      consumers.add(consumer);
      bindJobs(jobs);
      return () => {
        consumers.delete(consumer);
        releaseIfIdle();
      };
    },
    begin(projectId, projectName, skus) {
      const token = Symbol(projectId);
      const snapshot: EdmMediaRunSnapshot = { projectId, projectName, skus: [...skus], state: "starting", progress: "正在启动图片处理任务…" };
      pendingStarts.set(token, snapshot);
      snapshots.set(projectId, snapshot);
      publish();
      return token;
    },
    associate(token, runId) {
      const starting = pendingStarts.get(token);
      if (!starting) return;
      pendingStarts.delete(token);
      const context = { projectId: starting.projectId, projectName: starting.projectName, skus: starting.skus };
      contextsByRunId.set(runId, context);
      const progress = earlyProgress.get(runId);
      snapshots.set(starting.projectId, {
        ...starting,
        state: "running",
        runId,
        progress: progress?.message ?? "图片处理任务正在运行…",
      });
      publish();

      if (progress) handleProgress(progress);
      const result = earlyResults.get(runId);
      if (result) handleFinished(result, context);
    },
    fail(token, message) {
      const starting = pendingStarts.get(token);
      if (!starting) return;
      pendingStarts.delete(token);
      const current = snapshots.get(starting.projectId);
      if (current === starting) {
        snapshots.set(starting.projectId, { ...starting, state: "failed", progress: "", error: message });
        publish();
      }
      activeToast?.error(`项目「${starting.projectName}」${message}`);
      releaseIfIdle();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(projectId) {
      return snapshots.get(projectId) ?? null;
    },
  };
}

export const edmMediaJobMonitor = createEdmMediaJobMonitor();
