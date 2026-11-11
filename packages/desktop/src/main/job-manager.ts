import { atomicWrite, compareKeys, pathsForProject, readJsonl, type MediaJobCheckpoint, withLock } from "@siteindex/core";
import {
  EXIT,
  isValidMediaSkuRecoveryPartition,
  type AppSettings,
  type JobProgress,
  type JobRequest,
  type JobResult,
  type JobTrigger,
  type ProjectId,
  type ProjectPaths,
  type RunLog,
  type SiteIndexError,
} from "@siteindex/shared";
import { randomUUID } from "node:crypto";
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
import { readStableBoundedFile } from "./media-checkpoint-reader.js";

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
  /** E2E harness only; the production main process must leave this unset. */
  testOnlyAllowLoopbackHttp?: boolean;
  getWordPressCredential?(id: ProjectId, projectPath: string): Promise<WordPressCredential | null>;
  resolveProject(id: ProjectId): string | Promise<string>;
  resolveProjectPaths?(projectPath: string): Promise<ProjectPaths>;
  fork(modulePath: string): UtilityProcessLike;
  emitProgress(progress: JobProgress): void;
  emitFinished(result: JobResult): void;
  /** Test seam for proving a competing run cannot pass the project lock during synthetic history persistence. */
  testOnlyBeforeSyntheticRunLogCommit?(): Promise<void>;
  /** Fault injection for synthetic history I/O; production must leave these unset. */
  testOnlyReadSyntheticRunLog?(filePath: string): Promise<Record<string, unknown>[]>;
  testOnlyWriteSyntheticRunLog?(filePath: string, contents: string): Promise<void>;
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
  /** Core 的执行/checkpoint ID；不作为 Desktop 的活动 ID 暴露。 */
  coreRunId: string | null;
  runId: string | null;
  startedAt: string | null;
  result: JobResult | null;
  oosRate: number | null;
  workerPid: number | null;
  readySent: boolean;
  cancelled: boolean;
  finalizing: boolean;
  startupTimer: NodeJS.Timeout;
}

const MAX_MEDIA_CHECKPOINT_BYTES = 5 * 1024 * 1024;

class SyntheticRunLogPersistenceError extends Error {
  constructor(readonly operation: "read" | "write") {
    super(`Synthetic run history ${operation} failed.`);
    this.name = "SyntheticRunLogPersistenceError";
  }
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

function isSafeMediaImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sanitizeMediaJobResult(
  result: JobResult,
  sensitiveValues: readonly string[] = [],
  sensitiveUsernames: readonly string[] = [],
): JobResult {
  const sanitized = sanitizeJobResult(result, sensitiveValues, sensitiveUsernames);
  if (sanitized.job !== "media" || !isValidMediaSkuRecoveryPartition(sanitized)) return sanitized;
  return {
    runId: sanitized.runId,
    job: "media",
    status: sanitized.status,
    exitCode: sanitized.exitCode,
    summary: sanitized.summary,
    ...(sanitized.counts ? { counts: sanitized.counts } : {}),
    ...(sanitized.errors ? { errors: sanitized.errors } : {}),
    media_requested_skus: [...sanitized.media_requested_skus],
    media_batch_state: sanitized.media_batch_state,
    media_results: sanitized.media_results.map(({ sku, status, reason, image_url }) => ({
      sku,
      status,
      ...(reason ? { reason } : {}),
      ...(isSafeMediaImageUrl(image_url) ? { image_url } : {}),
    })),
    media_unknown_skus: [...sanitized.media_unknown_skus],
    media_not_started_skus: [...sanitized.media_not_started_skus],
    ...(sanitized.media_error_code ? { media_error_code: sanitized.media_error_code } : {}),
  };
}

function sanitizeMediaRunLog(row: RunLog): RunLog {
  if (row.job !== "media") return row;
  const safe: RunLog = {
    run_id: row.run_id,
    job: "media",
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    ...(row.trigger === "schedule" || row.trigger === "manual" || row.trigger === "cli"
      ? { trigger: row.trigger }
      : {}),
    ...(row.errors?.length ? { errors: ["媒体任务存在未公开的错误详情。"] } : {}),
  };
  if (!isValidMediaSkuRecoveryPartition(row)) return safe;

  safe.media_requested_skus = [...row.media_requested_skus];
  safe.media_batch_state = row.media_batch_state;
  safe.media_results = row.media_results.map(({ sku, status, image_url }) => ({
    sku,
    status,
    ...(isSafeMediaImageUrl(image_url) ? { image_url } : {}),
  }));
  safe.media_unknown_skus = [...row.media_unknown_skus];
  safe.media_not_started_skus = [...row.media_not_started_skus];
  if (row.media_error_code === "WP_AUTH_FAILED" || row.media_error_code === "WP_FORBIDDEN") {
    safe.media_error_code = row.media_error_code;
  }
  return safe;
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

async function recoverMediaCheckpoint(entry: JobEntry, fallback: JobResult): Promise<JobResult> {
  if (
    entry.request.job !== "media" ||
    !entry.runId ||
    fallback.job !== "media" ||
    !/^media-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.runId)
  ) return fallback;

  try {
    const projectRoot = path.resolve(entry.projectPath);
    const relativeDirectory = path.normalize(entry.projectPaths.jobLogsDir);
    if (path.isAbsolute(relativeDirectory) || relativeDirectory.split(path.sep).some((part) => part === "..")) return fallback;
    let logsDirectory = projectRoot;
    const guardedDirectories = [projectRoot];
    for (const part of relativeDirectory.split(path.sep).filter(Boolean)) {
      logsDirectory = path.join(logsDirectory, part);
      guardedDirectories.push(logsDirectory);
    }
    const checkpointPath = path.join(logsDirectory, `${entry.runId}.media.json`);
    const parsed: unknown = JSON.parse(
      await readStableBoundedFile(checkpointPath, MAX_MEDIA_CHECKPOINT_BYTES, guardedDirectories),
    );
    if (
      !isRecord(parsed) ||
      parsed.run_id !== entry.runId ||
      (parsed.checkpoint_state !== "running" && parsed.checkpoint_state !== "finished") ||
      !matchesMediaRecoveryRequest(parsed, entry.request.skus ?? [])
    ) return fallback;

    const checkpoint = parsed as unknown as MediaJobCheckpoint;
    if (
      checkpoint.media_error_code !== undefined &&
      checkpoint.media_error_code !== "WP_AUTH_FAILED" &&
      checkpoint.media_error_code !== "WP_FORBIDDEN"
    ) return fallback;

    const counts: Record<string, number> = {
      uploaded: 0,
      reused: 0,
      recorded: 0,
      skipped_has_url: 0,
      failed: 0,
      unknown: checkpoint.media_unknown_skus.length,
      not_started: checkpoint.media_not_started_skus.length,
    };
    for (const result of checkpoint.media_results) counts[result.status] = (counts[result.status] ?? 0) + 1;
    const recovered: JobResult = {
      ...fallback,
      // Checkpoints contain SKU outcomes, not a trustworthy process-level exit status.
      // A crashed worker must never be promoted to a successful Job from this file alone.
      status: fallback.status,
      exitCode: fallback.exitCode,
      summary:
        checkpoint.checkpoint_state === "finished"
          ? "媒体任务进程异常退出；已从完成检查点恢复 SKU 状态，任务整体仍按异常处理。"
          : "媒体任务进程异常退出；已从检查点恢复 SKU 状态。",
      counts,
      media_requested_skus: [...checkpoint.media_requested_skus],
      media_batch_state: checkpoint.media_batch_state,
      media_results: checkpoint.media_results.map((result) => ({ ...result })),
      media_unknown_skus: [...checkpoint.media_unknown_skus],
      media_not_started_skus: [...checkpoint.media_not_started_skus],
      ...(checkpoint.media_error_code ? { media_error_code: checkpoint.media_error_code } : {}),
      errors: fallback.errors ?? ["utilityProcess 异常退出；SKU 状态已从持久化检查点恢复。"],
    };
    return sanitizeMediaJobResult(recovered, entry.sensitiveValues, entry.sensitiveUsernames);
  } catch {
    return fallback;
  }
}

function hasSameMediaRecoveryPartition(left: unknown, right: JobResult): boolean {
  if (!isValidMediaSkuRecoveryPartition(left) || !isValidMediaSkuRecoveryPartition(right)) return false;
  const leftErrorCode = (left as unknown as { media_error_code?: string }).media_error_code ?? null;
  if (
    left.media_batch_state !== right.media_batch_state ||
    JSON.stringify(left.media_requested_skus) !== JSON.stringify(right.media_requested_skus) ||
    JSON.stringify(left.media_unknown_skus) !== JSON.stringify(right.media_unknown_skus) ||
    JSON.stringify(left.media_not_started_skus) !== JSON.stringify(right.media_not_started_skus) ||
    leftErrorCode !== (right.media_error_code ?? null) ||
    left.media_results.length !== right.media_results.length
  ) return false;
  return left.media_results.every((item, index) => {
    const current = right.media_results[index];
    return Boolean(
      current &&
      item.sku === current.sku &&
      item.status === current.status &&
      (item.reason ?? null) === (current.reason ?? null) &&
      (item.image_url ?? null) === (current.image_url ?? null),
    );
  });
}

function conservativeUnknownMediaResult(
  entry: JobEntry,
  result: JobResult,
  reason: { summary: string; error: string } = {
    summary: "媒体任务历史与当前请求不一致；为避免显示错误结果，逐 SKU 状态按未知处理。",
    error: "同 run_id 的媒体历史与当前请求不匹配；原历史已保留。",
  },
): JobResult {
  const recovery = unknownMediaRecovery(entry);
  const skuCount = recovery.media_requested_skus?.length ?? 0;
  const { media_error_code: _ignoredErrorCode, ...withoutCheckpointError } = result;
  return sanitizeMediaJobResult(
    {
      ...withoutCheckpointError,
      summary: reason.summary,
      errors: [...(result.errors ?? []), reason.error],
      counts: {
        uploaded: 0,
        reused: 0,
        recorded: 0,
        skipped_has_url: 0,
        failed: 0,
        unknown: skuCount,
        not_started: 0,
      },
      ...recovery,
    },
    entry.sensitiveValues,
    entry.sensitiveUsernames,
  );
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

  async function appendSyntheticRunLog(entry: JobEntry, result: JobResult): Promise<JobResult> {
    if (!entry.runId) return result;
    const filePath = path.join(entry.projectPath, entry.projectPaths.runs);
    let rows: Record<string, unknown>[];
    try {
      rows = options.testOnlyReadSyntheticRunLog
        ? await options.testOnlyReadSyntheticRunLog(filePath)
        : await readJsonl(filePath);
    } catch {
      throw new SyntheticRunLogPersistenceError("read");
    }
    {
      const existingRows = rows.filter((row) => row.run_id === entry.runId);
      const existing = existingRows[0];
      if (entry.request.job === "media" && existingRows.length > 0) {
        const matchesCurrentRequest =
          existingRows.length === 1 &&
          isRunLog(existing) &&
          existing.run_id === entry.runId &&
          existing.job === "media" &&
          matchesMediaRecoveryRequest(existing, entry.request.skus ?? []) &&
          isValidMediaSkuRecoveryPartition(existing) &&
          hasSameMediaRecoveryPartition(existing, result);
        if (!matchesCurrentRequest) {
          // A same-ID row that does not match this request is preserved, but never becomes current outcome data.
          return conservativeUnknownMediaResult(entry, result);
        }

        // Keep an already-written Core row intact. The live crash result remains failed even when the
        // durable Core row says success; the two facts are exposed separately to the caller.
        return result;
      }
      if (existing && isRunLog(existing) && existing.job === entry.request.job) {
        if (existing.job !== "media") {
          if (existing.status === "ok" && existing.finished_at !== null) return result;
        }
      }
      const record: RunLog = {
        run_id: entry.runId,
        job: entry.request.job,
        trigger: entry.trigger,
        device_name: entry.settings.device_name,
        started_at: entry.startedAt ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        status: result.status,
        ...(result.errors?.length ? { errors: result.errors } : {}),
        ...(isValidMediaSkuRecoveryPartition(result)
          ? {
              media_requested_skus: [...result.media_requested_skus],
              media_batch_state: result.media_batch_state,
              media_results: result.media_results.map((item) => ({ ...item })),
              media_unknown_skus: [...result.media_unknown_skus],
              media_not_started_skus: [...result.media_not_started_skus],
              ...(result.media_error_code ? { media_error_code: result.media_error_code } : {}),
            }
          : {}),
      };
      const next = rows.filter((row) => row.run_id !== entry.runId);
      next.push(record as unknown as Record<string, unknown>);
      next.sort((left, right) => compareKeys(String(left.run_id ?? ""), String(right.run_id ?? "")));
      try {
        await options.testOnlyBeforeSyntheticRunLogCommit?.();
        const contents = `${next.map((row) => JSON.stringify(row)).join("\n")}\n`;
        if (options.testOnlyWriteSyntheticRunLog) await options.testOnlyWriteSyntheticRunLog(filePath, contents);
        else await atomicWrite(filePath, contents);
      } catch {
        throw new SyntheticRunLogPersistenceError("write");
      }
      return result;
    }
  }

  async function finishEntry(entry: JobEntry, exitCode: number): Promise<void> {
    if (entry.finalizing) return;
    entry.finalizing = true;
    clearTimeout(entry.startupTimer);
    if (!entry.runId) {
      try {
        await withLock(entry.projectPath, async () => undefined, {
          deviceId: entry.settings.device_id,
          deviceName: entry.settings.device_name,
          job: "desktop-startup-cleanup",
        });
      } catch {
        // Live, foreign, or unverifiable locks stay untouched.
      }
      entry.rejectStarted(jobError("UNKNOWN", "Job utilityProcess 未能启动。", `exit code: ${exitCode}`));
      const result = processFailureResult(entry, exitCode);
      entry.resolveDone(result);
      removeEntry(entry);
      return;
    }

    let result = entry.result;
    if (!result) {
      const fallback = entry.cancelled ? cancelledResult(entry) : processFailureResult(entry, exitCode);
      let recoveryLockAcquired = false;
      try {
        // Core's real cross-process lock safely reclaims a dead worker lock or creates a fresh
        // main-process lock when the worker exited before acquiring Core's lock. It rejects live,
        // foreign, or unverifiable locks without touching them.
        result = await withLock(entry.projectPath, async () => {
          recoveryLockAcquired = true;
          const recovered = await recoverMediaCheckpoint(entry, fallback);
          return appendSyntheticRunLog(entry, recovered);
        }, {
          deviceId: entry.settings.device_id,
          deviceName: entry.settings.device_name,
          job: "desktop-media-recovery",
        });
      } catch (error) {
        const persistencePhase = error instanceof SyntheticRunLogPersistenceError ? error.operation : null;
        result = entry.request.job === "media"
          ? conservativeUnknownMediaResult(entry, fallback, recoveryLockAcquired
              ? persistencePhase === "read"
                ? {
                    summary: "媒体任务恢复历史读取失败；逐 SKU 状态按未知处理，请人工核查运行记录。",
                    error: "读取 runs.jsonl 失败，原历史未修改；请人工检查运行记录与媒体端实际状态后再重试。",
                  }
                : persistencePhase === "write"
                  ? {
                      summary: "媒体任务恢复历史写入失败；无法确认历史是否持久化，逐 SKU 状态按未知处理。",
                      error: "写入 runs.jsonl 失败，无法确认恢复历史是否已持久化；请人工检查运行记录与媒体端实际状态后再重试。",
                    }
                  : {
                  summary: "媒体任务恢复未能确认持久化；逐 SKU 状态按未知处理，请人工核查运行记录。",
                  error: "已取得项目运行锁，但恢复历史未能确认持久化；请人工检查 runs.jsonl 与媒体端实际状态后再重试。",
                  }
              : {
                  summary: "无法安全取得项目运行锁，恢复历史未写入；逐 SKU 状态按未知处理，请人工核查运行记录。",
                  error: "无法安全取得项目运行锁，原有历史保持不变；请人工检查项目锁、runs.jsonl 与媒体端实际状态后再重试。",
                })
          : {
              ...fallback,
              errors: [
                ...(fallback.errors ?? []),
                persistencePhase === "read"
                  ? "读取 runs.jsonl 失败；原历史未修改。"
                  : persistencePhase === "write"
                    ? "写入 runs.jsonl 失败；无法确认恢复历史是否已持久化。"
                    : "无法安全获取项目运行锁；本次恢复历史未写入。",
              ],
            };
      }
    } else {
      try {
        // Core normally releases its lock before sending finished. This no-op acquisition only
        // performs Core's safe stale-PID recovery if the utility process exited during cleanup.
        await withLock(entry.projectPath, async () => undefined, {
          deviceId: entry.settings.device_id,
          deviceName: entry.settings.device_name,
          job: "desktop-finished-cleanup",
        });
      } catch {
        // Do not disturb a lock another task or device currently owns.
      }
    }

    if (!entry.result && entry.cancelled) {
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
          ...(options.testOnlyAllowLoopbackHttp ? { testOnlyAllowLoopbackHttp: true } : {}),
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
      const runId = entry.request.job === "media" ? message.runId : `${message.runId}-${randomUUID()}`;
      if (!runId.trim() || entriesByRunId.has(runId)) {
        entry.rejectStarted(jobError("UNKNOWN", "Core 返回了重复或空的 Job 执行 ID。"));
        entry.child.kill();
        return;
      }
      entry.coreRunId = message.runId;
      entry.runId = runId;
      entry.startedAt = message.startedAt;
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
        message.result.job !== entry.request.job ||
        (entry.request.job === "media" && message.result.runId !== entry.coreRunId) ||
        (entry.request.job === "media" && !matchesMediaRecoveryRequest(message.result, entry.request.skus ?? []))
      )
        return;
      // This listener is bound to the utilityProcess created for this entry. Core may
      // recompute its business date at completion, so child ownership plus job name
      // attributes the result; finishEntry normalizes its runId to the external ID.
      entry.result = sanitizeMediaJobResult(message.result, entry.sensitiveValues, entry.sensitiveUsernames);
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
        coreRunId: null,
        runId: null,
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
        if (isRunLog(row)) history.push(sanitizeMediaRunLog(row as unknown as RunLog));
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
