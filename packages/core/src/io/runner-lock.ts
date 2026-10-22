import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFLICT_PATTERNS, EXIT, PATHS, type SiteIndexError, type SiteIndexErrorCode } from "@siteindex/shared";
import { atomicWrite } from "./atomic-write";

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
    const source = await readFile(path.join(project, PATHS.runner), "utf8");
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
  const json = `${JSON.stringify(runner, null, 2)}\n`;
  await atomicWrite(path.join(project, PATHS.runner), json);
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

async function openOrRecover(lockPath: string, staleAfterMs: number, now: () => Date) {
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let handle;
  try {
    handle = await open(lockPath, "r");
    const identity = await handle.stat();
    const text = await handle.readFile({ encoding: "utf8" });
    const record = JSON.parse(text) as Partial<LockRecord>;
    const heartbeat = typeof record.heartbeat === "string" ? Date.parse(record.heartbeat) : Number.NaN;
    if (!Number.isFinite(heartbeat) || now().getTime() - heartbeat <= staleAfterMs) {
      throw lockError("项目正在运行另一个任务，请稍后重试。");
    }
    const current = await lstat(lockPath);
    if (current.ino !== identity.ino || current.dev !== identity.dev) {
      throw lockError("项目运行锁刚刚更新，请稍后重试。");
    }
    const retired = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    await rename(lockPath, retired);
    await unlink(retired).catch(() => undefined);
    return await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw lockError("项目运行锁刚刚更新，请稍后重试。");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeLock(handle: Awaited<ReturnType<typeof open>>, record: LockRecord): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  await handle.sync();
}

export async function withLock<T>(project: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const lockPath = path.join(project, PATHS.lock);
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const started = now().toISOString();
  let handle;
  try {
    const parent = path.dirname(lockPath);
    await mkdir(parent, { recursive: true });
    handle = await openOrRecover(lockPath, staleAfterMs, now);
    const identity = await handle.stat();
    const record: LockRecord = {
      device_id: options.deviceId ?? "unknown",
      device_name: options.deviceName ?? "unknown",
      pid: process.pid,
      job: options.job ?? "unknown",
      started_at: started,
      heartbeat: started,
    };
    await writeLock(handle, record);
    let heartbeatError: unknown;
    let heartbeatTask = Promise.resolve();
    const timer = setInterval(() => {
      heartbeatTask = heartbeatTask.then(() => {
        record.heartbeat = now().toISOString();
        return writeLock(handle!, record);
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
      await handle.close();
      handle = undefined;
      try {
        const current = await lstat(lockPath);
        const currentRecord = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
        if (current.ino === identity.ino && current.dev === identity.dev && currentRecord.pid === record.pid && currentRecord.started_at === record.started_at) {
          await unlink(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
  } catch (error) {
    if (handle) {
      const identity = await handle.stat().catch(() => undefined);
      await handle.close().catch(() => undefined);
      const current = await lstat(lockPath).catch(() => undefined);
      if (identity && current?.ino === identity.ino && current.dev === identity.dev) await unlink(lockPath).catch(() => undefined);
    }
    throw error;
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
