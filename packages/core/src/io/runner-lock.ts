import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFLICT_PATTERNS, EXIT, pathsFor, type SiteIndexError, type SiteIndexErrorCode } from "@siteindex/shared";
import { atomicWrite } from "./atomic-write";
import { resolveProjectLayoutOrLegacy } from "./project-layout";

export interface RunnerConfig {
  device_id: string;
  device_name: string;
  claimed_at: string;
}

export interface LockRecord {
  device_id: string;
  device_name: string;
  pid: number;
  job: string;
  started_at: string;
  heartbeat: string;
}

export type RunnerTrigger = "schedule" | "manual" | "cli";
export interface LockOptions {
  deviceId?: string;
  deviceName?: string;
  job?: string;
  heartbeatMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

export class CoreIOError extends Error {
  readonly code: SiteIndexErrorCode;
  readonly exitCode: number;
  constructor(code: SiteIndexErrorCode, message: string, exitCode: number) {
    super(message);
    this.name = "CoreIOError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function readRunner(project: string): Promise<RunnerConfig | null> {
  try {
    const paths = pathsFor(await resolveProjectLayoutOrLegacy(project));
    const source = await readFile(path.join(project, paths.runner), "utf8");
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.device_id !== "string" || typeof row.device_name !== "string" || typeof row.claimed_at !== "string") return null;
    return { device_id: row.device_id, device_name: row.device_name, claimed_at: row.claimed_at };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeRunner(project: string, runner: RunnerConfig): Promise<void> {
  const paths = pathsFor(await resolveProjectLayoutOrLegacy(project));
  const json = `${JSON.stringify(runner, null, 2)}\n`;
  await atomicWrite(path.join(project, paths.runner), json);
}

export async function assertRunner(project: string, deviceId: string, trigger: RunnerTrigger): Promise<void> {
  if (trigger !== "schedule") return;
  const runner = await readRunner(project);
  if (runner?.device_id === deviceId) return;
  const error: SiteIndexError & { exitCode: number } = {
    code: "NOT_RUNNER",
    message: "当前设备不是此项目的定时任务执行设备。",
    exitCode: EXIT.NOT_RUNNER,
  };
  throw error;
}

function lockError(message: string): CoreIOError {
  return new CoreIOError("LOCKED", message, EXIT.LOCKED);
}

const LOCK_READ_RETRIES = 8;
const LOCK_READ_RETRY_MS = 10;

type ProcessPresence = "alive" | "dead" | "unknown";

function processPresence(pid: number): ProcessPresence {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM and platform-specific probe failures are ambiguous. Keep the lock conservatively.
    return "unknown";
  }
}

async function openOrRecover(lockPath: string, staleAfterMs: number, now: () => Date) {
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  for (let attempt = 0; attempt <= LOCK_READ_RETRIES; attempt += 1) {
    let handle;
    let incomplete = false;
    try {
      handle = await open(lockPath, "r");
      const identity = await handle.stat();
      const text = await handle.readFile({ encoding: "utf8" });
      let record: Partial<LockRecord> | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          record = parsed as Partial<LockRecord>;
        } else {
          incomplete = true;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        incomplete = true;
      }
      const heartbeat = typeof record?.heartbeat === "string" ? Date.parse(record.heartbeat) : Number.NaN;
      if (!Number.isFinite(heartbeat)) incomplete = true;
      const lastActivity = Number.isFinite(heartbeat) ? heartbeat : identity.mtimeMs;
      const stale = Number.isFinite(lastActivity) && now().getTime() - lastActivity > staleAfterMs;
      const presence = typeof record?.pid === "number" ? processPresence(record.pid) : "unknown";
      const definitelyDead = presence === "dead";
      // A fresh heartbeat is not evidence that its writer survived a forced process exit.
      // Conversely, a live or unprobeable PID is never stolen, even after a long stall:
      // this also treats PID reuse conservatively rather than killing another process's job.
      const reclaimable = definitelyDead || (stale && !record?.pid);

      if (incomplete && !stale && !definitelyDead) {
        if (attempt < LOCK_READ_RETRIES) continue;
        throw lockError("项目运行锁内容尚未写入完成，请稍后重试。");
      }
      if (!reclaimable) throw lockError("项目正在运行另一个任务，请稍后重试。");

      const current = await lstat(lockPath);
      if (current.ino !== identity.ino || current.dev !== identity.dev
        || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs) {
        throw lockError("项目运行锁刚刚更新，请稍后重试。");
      }
      const retired = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      await rename(lockPath, retired);
      await unlink(retired).catch(() => undefined);
      return await open(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") {
        throw lockError("项目运行锁刚刚更新，请稍后重试。");
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  throw lockError("项目运行锁内容尚未写入完成，请稍后重试。");
}

async function writeLock(lockPath: string, record: LockRecord): Promise<LockIdentity> {
  await atomicWrite(lockPath, `${JSON.stringify(record)}\n`);
  const written = await lstat(lockPath);
  return { ino: written.ino, dev: written.dev };
}

type LockIdentity = { ino: number; dev: number };
type LockUnlinkOptions = { unlinkFile?: (filePath: string) => Promise<void>; wait?: (ms: number) => Promise<void> };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 只移除仍属于本次任务的锁；Windows 上遇到短暂占用时按原子写策略重试。 */
export async function unlinkOwnedLock(
  lockPath: string,
  identity: LockIdentity,
  expected?: Pick<LockRecord, "pid" | "started_at">,
  options: LockUnlinkOptions = {},
): Promise<void> {
  const remove = options.unlinkFile ?? unlink;
  const pause = options.wait ?? wait;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const current = await lstat(lockPath);
      if (current.ino !== identity.ino || current.dev !== identity.dev) return;
      if (expected) {
        let currentRecord: Partial<LockRecord> | null = null;
        try { currentRecord = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (currentRecord && (currentRecord.pid !== expected.pid || currentRecord.started_at !== expected.started_at)) return;
      }
      const latest = await lstat(lockPath);
      if (latest.ino !== identity.ino || latest.dev !== identity.dev) return;
      await remove(lockPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 10) throw error;
      await pause(200 * (attempt + 1));
    }
  }
}

async function withExclusiveLock<T>(project: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const paths = pathsFor(await resolveProjectLayoutOrLegacy(project));
  const lockPath = path.join(project, paths.lock);
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const started = now().toISOString();
  let handle;
  let identity: LockIdentity | undefined;
  let record: LockRecord | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (!identity || cleaned) return;
    await unlinkOwnedLock(lockPath, identity, record ? { pid: record.pid, started_at: record.started_at } : undefined);
    cleaned = true;
  };
  try {
    const parent = path.dirname(lockPath);
    await mkdir(parent, { recursive: true });
    handle = await openOrRecover(lockPath, staleAfterMs, now);
    const reservation = await handle.stat();
    identity = { ino: reservation.ino, dev: reservation.dev };
    record = {
      device_id: options.deviceId ?? "unknown",
      device_name: options.deviceName ?? "unknown",
      pid: process.pid,
      job: options.job ?? "unknown",
      started_at: started,
      heartbeat: started,
    };
    await handle.close();
    handle = undefined;
    identity = await writeLock(lockPath, record);
    let heartbeatError: unknown;
    let heartbeatTask = Promise.resolve();
    const timer = setInterval(() => {
      heartbeatTask = heartbeatTask.then(() => {
        record!.heartbeat = now().toISOString();
        return writeLock(lockPath, record!).then((writtenIdentity) => { identity = writtenIdentity; });
      }).catch((error: unknown) => { heartbeatError = error; });
    }, heartbeatMs);
    timer.unref?.();
    try {
      const result = await fn();
      if (heartbeatError) throw heartbeatError;
      return result;
    } finally {
      clearInterval(timer);
      await heartbeatTask;
      await cleanup();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await cleanup().catch(() => undefined);
    throw error;
  }
}

interface LockContextToken { active: boolean }
const lockContext = new AsyncLocalStorage<Map<string, LockContextToken>>();

/**
 * Acquire one cross-process project lock. Nested calls in the same async operation reuse
 * its live lock, so Core services can protect a whole Job while lower-level readers and
 * writers keep their own safe public entry points.
 */
export async function withLock<T>(project: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const key = path.resolve(project);
  const inherited = lockContext.getStore();
  const current = inherited?.get(key);
  if (current?.active) return await fn();

  const token: LockContextToken = { active: true };
  const next = new Map(inherited ?? []);
  next.set(key, token);
  try {
    return await withExclusiveLock(project, () => lockContext.run(next, async () => {
      try { return await fn(); }
      finally { token.active = false; }
    }), options);
  } finally {
    // Detached async work inherits the ALS map; invalidate the token as soon as its
    // owning file lock is released so later work must acquire a fresh cross-process lock.
    token.active = false;
  }
}

export function isConflictCopy(fileName: string, patterns: readonly string[] = DEFAULT_CONFLICT_PATTERNS): boolean {
  return patterns.some((pattern) => {
    try { return new RegExp(pattern, "i").test(fileName); }
    catch { return fileName.toLowerCase().includes(pattern.toLowerCase()); }
  });
}

export async function findConflictCopies(directory: string, patterns: readonly string[] = DEFAULT_CONFLICT_PATTERNS): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => isConflictCopy(name, patterns)).map((name) => path.join(directory, name));
}
