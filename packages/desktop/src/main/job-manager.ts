import { pathsForProject, readJsonl, writeJsonl } from "@siteindex/core";
import {
  EXIT,
  type AppSettings,
  type JobProgress,
  type JobRequest,
  type JobResult,
  type JobTrigger,
  type MediaSkuRecoveryPartition,
  type ProjectId,
  type ProjectPaths,
  type RunLog,
  type SiteIndexError,
} from "@siteindex/shared";
import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { WordPressCredential } from "../shared/wordpress-credential-types.js";
import {
  isJobName,
  isJobProgress,
  isJobResult,
  isRecord,
  matchesMediaRecoveryRequest,
  shouldNotify,
  type JobWorkerMessage,
  type JobWorkerStartMessage,
} from "./job-protocol.js";
import {
  sanitizeJobProgress,
  sanitizeJobResult,
  sanitizeWorkerText,
  wordpressCredentialSensitiveValues,
  wordpressCredentialUsernames,
} from "./worker-output-sanitizer.js";

const START_TIMEOUT_MS = 30_000;

export interface UtilityProcessLike {
  readonly pid: number | undefined;
  on(event: "message", listener: (message: unknown) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export interface JobManagerOptions {
  workerPath: string;
  getSettings(): Promise<AppSettings>;
  getBrowserExecutablePath?(settings: AppSettings): Promise<string | null>;
  isMediaJobReady?(): boolean;
  getWordPressCredential?(id: ProjectId, projectPath: string): Promise<WordPressCredential | null>;
  resolveProject(id: ProjectId): string | Promise<string>;
  resolveProjectPaths?(projectPath: string): Promise<ProjectPaths>;
  fork(modulePath: string): UtilityProcessLike;
  emitProgress(progress: JobProgress): void;
  emitFinished(result: JobResult): void;
  finalizeInit?(
    result: JobResult,
    projectPath: string,
    emitProgress: (progress: JobProgress) => void,
  ): Promise<JobResult>;
  notify(result: JobResult, settings: AppSettings, oosRate: number | null): void;
}

interface JobEntry {
  key: string;
  projectPath: string;
  projectPaths: ProjectPaths;
  projectId: ProjectId;
  request: Omit<JobRequest, "trigger">;
  trigger: JobTrigger;
  settings: AppSettings;
  browserPath: string | null;
  wordpressCredential: WordPressCredential | null;
  sensitiveValues: string[];
  sensitiveUsernames: string[];
  child: UtilityProcessLike;
  started: Promise<string>;
  resolveStarted(runId: string): void;
  rejectStarted(error: SiteIndexError): void;
  done: Promise<JobResult>;
  resolveDone(result: JobResult): void;
  runId: string | null;
  coreRunId: string | null;
  startedAt: string | null;
  result: JobResult | null;
  oosRate: number | null;
  workerPid: number | null;
  readySent: boolean;
  cancelled: boolean;
  finalizing: boolean;
  startupTimer: NodeJS.Timeout;
}

function jobError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function mediaJobNotImplementedError(): Error & { code: "NOT_IMPLEMENTED"; detail: string } {
  const error = new Error("当前桌面版本尚未接入媒体准备 Core Job。") as Error & {
    code: "NOT_IMPLEMENTED";
    detail: string;
  };
  error.code = "NOT_IMPLEMENTED";
  error.detail = "Core media Job 尚未就绪。";
  return error;
}

function projectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isRunLog(value: unknown): value is RunLog {
  if (!isRecord(value)) return false;
  return (
    typeof value.run_id === "string" &&
    isJobName(value.job) &&
    typeof value.started_at === "string" &&
    (value.finished_at === null || typeof value.finished_at === "string") &&
    (value.status === "ok" || value.status === "partial" || value.status === "failed" || value.status === "skipped")
  );
}

function cancelledResult(entry: JobEntry): JobResult {
  return {
    runId: entry.runId ?? `${new Date().toISOString().slice(0, 10)}-${entry.request.job}`,
    job: entry.request.job,
    status: "failed",
    exitCode: EXIT.GUARD_ABORTED,
    summary: "任务已取消。",
    errors: ["用户已取消任务。"],
    ...unknownMediaRecovery(entry),
  };
}

function processFailureResult(entry: JobEntry, code: number): JobResult {
  return {
    runId: entry.runId ?? `${new Date().toISOString().slice(0, 10)}-${entry.request.job}`,
    job: entry.request.job,
    status: "failed",
    exitCode: EXIT.SOURCE_FAILED,
    summary: "Job 执行进程异常退出。",
    errors: [`utilityProcess exit code: ${code}`],
    ...unknownMediaRecovery(entry),
  };
}

function unknownMediaRecovery(entry: JobEntry): Partial<JobResult> {
  if (entry.request.job !== "media") return {};
  const skus = [...new Set(entry.request.skus ?? [])];
  return {
    media_requested_skus: skus,
    media_batch_state: "outcome_unknown",
    media_results: [],
    media_unknown_skus: skus,
    media_not_started_skus: [],
  };
}

function copyMediaRecovery(value: MediaSkuRecoveryPartition & { media_error_code?: unknown }): Partial<JobResult> {
  return {
    media_requested_skus: [...value.media_requested_skus],
    media_batch_state: value.media_batch_state,
    media_results: value.media_results.map((item) => ({ ...item })),
    media_unknown_skus: [...value.media_unknown_skus],
    media_not_started_skus: [...value.media_not_started_skus],
    ...(value.media_error_code === "WP_AUTH_FAILED" || value.media_error_code === "WP_FORBIDDEN"
      ? { media_error_code: value.media_error_code }
      : {}),
  };
}

function persistedMediaRecovery(entry: JobEntry, rows: Record<string, unknown>[]): Partial<JobResult> {
  if (entry.request.job !== "media") return {};
  const prior = rows.find((row) => row.run_id === entry.coreRunId && row.job === "media");
  if (prior && matchesMediaRecoveryRequest(prior, entry.request.skus ?? [])) {
    return copyMediaRecovery(prior);
  }
  return unknownMediaRecovery(entry);
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

export function createJobManager(options: JobManagerOptions) {
  const entriesByProject = new Map<string, JobEntry>();
  const startingByProject = new Set<string>();
  const entriesByRunId = new Map<string, JobEntry>();
  const idleWaiters = new Set<() => void>();
  let acceptingJobs = true;

  function notifyIdleWaitersIfIdle(): void {
    if (entriesByProject.size !== 0 || startingByProject.size !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function waitForIdle(): Promise<void> {
    if (entriesByProject.size === 0 && startingByProject.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  }

  function removeEntry(entry: JobEntry): void {
    if (entriesByProject.get(entry.key) === entry) entriesByProject.delete(entry.key);
    if (entry.runId && entriesByRunId.get(entry.runId) === entry) entriesByRunId.delete(entry.runId);
    clearTimeout(entry.startupTimer);
    entry.wordpressCredential = null;
    entry.sensitiveValues.fill("");
    entry.sensitiveValues.length = 0;
    entry.sensitiveUsernames.fill("");
    entry.sensitiveUsernames.length = 0;
    notifyIdleWaitersIfIdle();
  }

  async function releaseOwnedLock(entry: JobEntry): Promise<void> {
    const pid = entry.workerPid;
    if (pid === null) return;
    const lockPath = path.join(entry.projectPath, entry.projectPaths.lock);
    try {
      const identity = await lstat(lockPath);
      const text = await readFile(lockPath, "utf8");
      const lock: unknown = JSON.parse(text);
      if (
        !isRecord(lock) ||
        lock.pid !== pid ||
        lock.job !== entry.request.job ||
        lock.device_id !== entry.settings.device_id
      )
        return;
      const current = await lstat(lockPath);
      if (current.ino === identity.ino && current.dev === identity.dev) await unlink(lockPath);
    } catch {
      // Job 进程异常退出后，锁清理尽力进行；不可读时留给 core 的陈旧锁回收。
    }
  }

  async function appendSyntheticRunLog(entry: JobEntry, result: JobResult): Promise<JobResult> {
    if (!entry.coreRunId) return result;
    try {
      const filePath = path.join(entry.projectPath, entry.projectPaths.runs);
      const rows = await readJsonl(filePath);
      const recovery = persistedMediaRecovery(entry, rows);
      const safeResult = { ...result, ...recovery };
      const record: RunLog = {
        run_id: entry.coreRunId,
        job: entry.request.job,
        trigger: entry.trigger,
        device_name: entry.settings.device_name,
        started_at: entry.startedAt ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        status: result.status,
        ...(result.errors?.length ? { errors: result.errors } : {}),
        ...recovery,
      };
      const next = rows.filter((row) => row.run_id !== entry.coreRunId);
      next.push(record as unknown as Record<string, unknown>);
      await writeJsonl(filePath, next, "run_log");
      return safeResult;
    } catch {
      // 项目文件不可写时仍把失败结果发回界面。
      return result;
    }
  }

  async function finishEntry(entry: JobEntry, exitCode: number): Promise<void> {
    if (entry.finalizing) return;
    entry.finalizing = true;
    clearTimeout(entry.startupTimer);
    await releaseOwnedLock(entry);

    if (!entry.runId) {
      entry.rejectStarted(jobError("UNKNOWN", "Job utilityProcess 未能启动。", `exit code: ${exitCode}`));
      const result = processFailureResult(entry, exitCode);
      entry.resolveDone(result);
      removeEntry(entry);
      return;
    }

    let result = entry.result;
    if (!result) {
      result = entry.cancelled ? cancelledResult(entry) : processFailureResult(entry, exitCode);
      result = await appendSyntheticRunLog(entry, result);
      if (entry.cancelled) {
        options.emitProgress({
          runId: result.runId,
          projectPath: entry.projectPath,
          job: entry.request.job,
          pct: null,
          step: "cancelled",
          level: "warn",
          message: result.summary,
          at: new Date().toISOString(),
        });
      }
    }

    if (result.runId !== entry.runId) result = { ...result, runId: entry.runId };
    if (entry.request.job === "init" && entry.cancelled) {
      result = {
        ...result,
        steps: [
          ...(result.steps ?? []).filter((step) => step.key !== "schedule"),
          { key: "schedule", status: "skipped", message: "初始化已取消，未注册定时任务。" },
        ],
      };
    } else if (entry.request.job === "init" && options.finalizeInit) {
      try {
        result = await options.finalizeInit(result, entry.projectPath, options.emitProgress);
      } catch (error) {
        const message = `定时任务注册失败：${error instanceof Error ? error.message : String(error)}`;
        result = {
          ...result,
          status: result.status === "ok" ? "partial" : result.status,
          exitCode: result.exitCode === EXIT.OK ? EXIT.SOURCE_FAILED : result.exitCode,
          errors: [...(result.errors ?? []), message],
          steps: [
            ...(result.steps ?? []).filter((step) => step.key !== "schedule"),
            { key: "schedule", status: "failed", message },
          ],
        };
        options.emitProgress({
          runId: result.runId,
          projectPath: entry.projectPath,
          job: "init",
          pct: 100,
          step: "schedule",
          level: "error",
          message,
          at: new Date().toISOString(),
        });
      }
    }
    options.emitFinished(result);
    if (!entry.cancelled) {
      try {
        const settings = await options.getSettings();
        if (shouldNotify(settings, result, entry.oosRate)) options.notify(result, settings, entry.oosRate);
      } catch {
        // 通知配置不可用时不改变 Job 的执行结果。
      }
    }
    entry.resolveDone(result);
    removeEntry(entry);
  }

  function handleMessage(entry: JobEntry, value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    const message = value as unknown as JobWorkerMessage;
    if (message.type === "ready") {
      if (entry.readySent) return;
      entry.readySent = true;
      const workerMessage: JobWorkerStartMessage = {
        type: "run",
        request: { ...entry.request, projectPath: entry.projectPath, trigger: entry.trigger },
        context: {
          deviceId: entry.settings.device_id,
          deviceName: entry.settings.device_name,
          cacheDir: entry.settings.cache_dir,
          browserPath: entry.browserPath,
          ...(entry.wordpressCredential ? { wordpressCredential: entry.wordpressCredential } : {}),
        },
      };
      entry.child.postMessage(workerMessage);
      workerMessage.context.wordpressCredential = undefined;
      entry.wordpressCredential = null;
      return;
    }
    if (message.type === "started") {
      if (typeof message.runId !== "string" || typeof message.startedAt !== "string" || entry.runId) return;
      entry.runId = message.runId;
      entry.startedAt = message.startedAt;
      entry.coreRunId = message.runId;
      entry.runId = `${message.runId}-${randomUUID()}`;
      entry.workerPid = entry.child.pid ?? null;
      clearTimeout(entry.startupTimer);
      entriesByRunId.set(entry.runId, entry);
      entry.resolveStarted(entry.runId);
      return;
    }
    if (message.type === "progress") {
      if (isJobProgress(message.progress)) {
        if (entry.request.job === "init" && message.progress.step === "schedule") return;
        // Known credential-derived values are redacted even without recognizable auth labels.
        options.emitProgress({
          ...sanitizeJobProgress(message.progress, entry.sensitiveValues, entry.sensitiveUsernames),
          runId: entry.runId ?? message.progress.runId,
        });
      }
      return;
    }
    if (message.type === "finished") {
      if (
        !isJobResult(message.result) ||
        (entry.request.job === "media" && !matchesMediaRecoveryRequest(message.result, entry.request.skus ?? []))
      )
        return;
      entry.result = sanitizeJobResult(message.result, entry.sensitiveValues, entry.sensitiveUsernames);
      entry.oosRate = typeof message.oosRate === "number" ? message.oosRate : null;
      entry.child.kill();
      return;
    }
    if (message.type === "fatal") {
      const detail =
        typeof message.message === "string"
          ? sanitizeWorkerText(message.message, entry.sensitiveValues, entry.sensitiveUsernames)
          : "未知 Worker 错误。";
      if (!entry.runId) entry.rejectStarted(jobError("UNKNOWN", "Job utilityProcess 执行失败。", detail));
      entry.child.kill();
    }
  }

  async function start(request: Omit<JobRequest, "trigger">, trigger: JobTrigger, allowMedia = false) {
    if (!acceptingJobs) throw jobError("LOCKED", "软件即将安装更新，暂时无法启动任务。");
    if (!request || typeof request.projectPath !== "string" || !request.projectPath.trim() || !isJobName(request.job)) {
      throw jobError("CONFIG_INVALID", "Job 请求无效。");
    }
    if ((request.job === "media") !== allowMedia) throw jobError("CONFIG_INVALID", "media 任务只能通过专用接口启动。");
    if (request.job === "media" && !options.isMediaJobReady?.()) throw mediaJobNotImplementedError();
    if (
      request.job === "media" &&
      (!Array.isArray(request.skus) ||
        request.skus.length === 0 ||
        request.skus.some((sku) => typeof sku !== "string" || !sku.trim()))
    ) {
      throw jobError("CONFIG_INVALID", "媒体准备 SKU 列表无效。");
    }
    const projectPath = path.resolve(request.projectPath);
    const key = projectKey(projectPath);
    if (entriesByProject.has(key) || startingByProject.has(key)) {
      throw jobError("LOCKED", "此项目已有任务正在运行。", projectPath);
    }
    startingByProject.add(key);
    let transferredToEntry = false;
    try {
      const settings = await options.getSettings();
      const browserPath = options.getBrowserExecutablePath
        ? await options.getBrowserExecutablePath(settings)
        : settings.browser.executable_path;
      const projectId = path.basename(projectPath) as ProjectId;
      const wordpressCredential =
        request.job === "media" ? await options.getWordPressCredential?.(projectId, projectPath) : null;
      if (request.job === "media" && !wordpressCredential) {
        throw jobError("WP_NOT_CONFIGURED", "尚未配置此项目的 WordPress 应用程序密码。");
      }
      const sensitiveValues = wordpressCredential ? wordpressCredentialSensitiveValues(wordpressCredential) : [];
      const sensitiveUsernames = wordpressCredential ? wordpressCredentialUsernames(wordpressCredential) : [];
      if (
        sensitiveValues.some(
          (secret) =>
            secret && (projectPath.includes(secret) || (request.skus ?? []).some((sku) => sku.includes(secret))),
        )
      ) {
        throw jobError("CONFIG_INVALID", "媒体准备请求包含不允许的敏感内容。");
      }
      const safeRequest: Omit<JobRequest, "trigger"> = {
        projectPath,
        job: request.job,
        ...(request.job === "media"
          ? { skus: [...new Set(request.skus as string[])] }
          : {
              ...(typeof request.only === "string" ? { only: request.only } : {}),
              ...(typeof request.date === "string" ? { date: request.date } : {}),
              ...(typeof request.force === "boolean" ? { force: request.force } : {}),
              ...(typeof request.dryRun === "boolean" ? { dryRun: request.dryRun } : {}),
            }),
      };
      if (!acceptingJobs) throw jobError("LOCKED", "软件即将安装更新，暂时无法启动任务。");
      const projectPaths = await (options.resolveProjectPaths ?? pathsForProject)(projectPath);
      if (!acceptingJobs) throw jobError("LOCKED", "软件即将安装更新，暂时无法启动任务。");
      const child = options.fork(options.workerPath);

      let resolveStarted!: (runId: string) => void;
      let rejectStarted!: (error: SiteIndexError) => void;
      let resolveDone!: (result: JobResult) => void;
      const started = new Promise<string>((resolveStartedValue, rejectStartedValue) => {
        resolveStarted = resolveStartedValue;
        rejectStarted = rejectStartedValue;
      });
      const done = new Promise<JobResult>((resolveDoneValue) => {
        resolveDone = resolveDoneValue;
      });
      const entry: JobEntry = {
        key,
        projectPath,
        projectPaths,
        projectId,
        request: safeRequest,
        trigger,
        settings,
        browserPath,
        wordpressCredential: wordpressCredential ?? null,
        sensitiveValues,
        sensitiveUsernames,
        child,
        started,
        resolveStarted,
        rejectStarted,
        done,
        resolveDone,
        runId: null,
        coreRunId: null,
        startedAt: null,
        result: null,
        oosRate: null,
        workerPid: child.pid ?? null,
        readySent: false,
        cancelled: false,
        finalizing: false,
        startupTimer: setTimeout(() => {
          entry.cancelled = true;
          child.kill();
          rejectStarted(jobError("UNKNOWN", "Job utilityProcess 启动超时。"));
        }, START_TIMEOUT_MS),
      };
      entry.startupTimer.unref?.();
      startingByProject.delete(key);
      entriesByProject.set(key, entry);
      transferredToEntry = true;
      child.on("message", (message) => handleMessage(entry, message));
      child.once("exit", (code) => {
        void finishEntry(entry, code);
      });
      notifyIdleWaitersIfIdle();

      try {
        const runId = await started;
        return { runId, done };
      } catch (error) {
        await done;
        throw error;
      }
    } finally {
      if (!transferredToEntry) {
        startingByProject.delete(key);
        notifyIdleWaitersIfIdle();
      }
    }
  }

  return {
    async pauseAndWaitForIdle(): Promise<void> {
      acceptingJobs = false;
      await waitForIdle();
    },
    resumeJobs(): void {
      acceptingJobs = true;
    },
    async run(request: Omit<JobRequest, "trigger">) {
      const started = await start(request, "manual");
      return { runId: started.runId };
    },
    async runMedia(request: Omit<JobRequest, "trigger" | "job"> & { job: "media" }) {
      const started = await start(request, "manual", true);
      return { runId: started.runId };
    },
    async runAndWait(request: Omit<JobRequest, "trigger">, trigger: JobTrigger): Promise<JobResult> {
      const started = await start(request, trigger);
      return started.done;
    },
    async cancel(runId: string): Promise<void> {
      const entry = entriesByRunId.get(runId);
      if (!entry || entry.result) return;
      entry.cancelled = true;
      entry.child.kill();
      await entry.done;
    },
    async history(id: ProjectId, limit?: number): Promise<RunLog[]> {
      const projectPath = await options.resolveProject(id);
      const projectPaths = await pathsForProject(projectPath);
      const rows = await readJsonl(path.join(projectPath, projectPaths.runs));
      const history: RunLog[] = [];
      for (const row of rows) {
        if (isRunLog(row)) history.push(row as unknown as RunLog);
      }
      return history

        .sort((left, right) => right.started_at.localeCompare(left.started_at))
        .slice(0, normalizeLimit(limit));
    },
    running(id: ProjectId): { runId: string; job: string } | null {
      for (const entry of entriesByProject.values()) {
        if (entry.projectId === id && entry.runId) return { runId: entry.runId, job: entry.request.job };
      }
      return null;
    },
    async shutdown(): Promise<void> {
      acceptingJobs = false;
      const active = [...entriesByProject.values()];
      for (const entry of active) {
        if (!entry.result) {
          entry.cancelled = true;
          entry.child.kill();
        }
      }
      await Promise.all(active.map((entry) => entry.done));
      await waitForIdle();
    },
    get activeCount(): number {
      return entriesByProject.size + startingByProject.size;
    },
  };
}

export type JobManager = ReturnType<typeof createJobManager>;
