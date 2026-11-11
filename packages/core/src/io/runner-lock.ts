import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, lstat, mkdir, readdir, link, realpath } from "node:fs/promises";
import os from "node:os";
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
  host_id: string;
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
const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let localHostIdPromise: Promise<string> | undefined;

/** @internal Deterministic synchronization hooks for cross-process lock regression tests. */
export interface RunnerLockTestHooks {
  afterStaleLockValidated?: () => Promise<void>;
  afterReclaimClaimPublished?: () => Promise<void>;
  renameStaleLock?: (lockPath: string, retiredPath: string) => Promise<void>;
}

const runnerLockTestHooks = new AsyncLocalStorage<RunnerLockTestHooks>();

/** Persist an opaque identity outside project folders so cloud-synced lock records stay host-specific. */
function localHostIdFile(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData || !path.win32.isAbsolute(localAppData) || localAppData.startsWith("\\\\")) {
      throw lockError("无法访问本机锁身份存储；请检查 LOCALAPPDATA 后重试。为避免多设备并发写入，项目锁未创建。");
    }
    return path.win32.join(localAppData, "SiteIndex", "lock-host-id");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "SiteIndex", "lock-host-id");
  }
  const stateHome = process.env.XDG_STATE_HOME?.trim();
  const stateRoot = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(home, ".local", "state");
  return path.join(stateRoot, "siteindex", "lock-host-id");
}

interface LocalHostIdInitializationHooks {
  /** Internal synchronization seam for deterministic cross-process I/O tests. */
  beforePublish?: () => Promise<void>;
  /** Internal crash seam for deterministic publication recovery tests. */
  afterPublish?: () => Promise<void>;
}

/**
 * Reads or creates the local host identity without exposing a partial final file.
 * The identity is staged and synced first, then hard-linked into place so only one
 * process can publish it and every reader sees the complete contents.
 */
export async function readOrCreateLocalHostId(
  filePath: string,
  hooks: LocalHostIdInitializationHooks = {},
): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const readExisting = async (): Promise<string> => {
    for (let attempt = 0; attempt <= LOCK_READ_RETRIES; attempt += 1) {
      let source: string;
      try {
        source = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === LOCK_READ_RETRIES) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_READ_RETRY_MS));
        continue;
      }
      const value = source.trim();
      if (HOST_ID_PATTERN.test(value)) return value;
      if (attempt < LOCK_READ_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_READ_RETRY_MS));
        continue;
      }
      throw lockError("本机锁身份文件无效；为避免错误回收项目锁，Core 已停止。");
    }
    throw lockError("本机锁身份文件尚未写入完成；请稍后重试。");
  };
  try {
    return await readExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const value = randomUUID();
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  let tempCreated = false;
  try {
    handle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforePublish?.();
    try {
      // link() atomically adds a directory entry without replacing an existing identity.
      await link(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw lockError("无法安全发布本机锁身份文件；为避免多设备并发写入，项目锁未创建。");
      }
      return readExisting();
    }
    await hooks.afterPublish?.();
    return value;
  } finally {
    await handle?.close().catch(() => undefined);
    if (tempCreated) await unlink(tempPath).catch(() => undefined);
  }
}

async function localHostId(): Promise<string> {
  if (!localHostIdPromise) {
    const pending = readOrCreateLocalHostId(localHostIdFile());
    localHostIdPromise = pending;
    void pending.catch(() => { if (localHostIdPromise === pending) localHostIdPromise = undefined; });
  }
  return localHostIdPromise;
}

type ProcessPresence = "alive" | "dead" | "unknown";

interface ReclaimClaim {
  version: 1;
  host_id: string;
  pid: number;
  token: string;
  lock_key: string;
  previous_token: string | null;
}

interface ReclaimClaimLease {
  entries: Array<{
    file: string;
    tempFile: string;
    claim: ReclaimClaim;
    identity: { dev: number; ino: number };
  }>;
  directory: string;
  lockKey: string;
}

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

async function openOrRecover(lockPath: string, currentHostId: string) {
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  for (let attempt = 0; attempt <= LOCK_READ_RETRIES; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "r");
      const identity = await handle.stat();
      const text = await handle.readFile({ encoding: "utf8" });
      let record: Partial<LockRecord> | null = null;
      let malformed = false;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          record = parsed as Partial<LockRecord>;
        } else {
          malformed = true;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        malformed = true;
      }
      if (malformed && attempt < LOCK_READ_RETRIES) continue;
      if (!record) {
        if (attempt < LOCK_READ_RETRIES) continue;
        throw lockError("项目运行锁缺少有效主机身份或进程信息；为避免多设备并发写入，锁未回收。");
      }
      const heartbeat = typeof record.heartbeat === "string" ? Date.parse(record.heartbeat) : Number.NaN;
      if (typeof record.host_id !== "string" || !HOST_ID_PATTERN.test(record.host_id)
        || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0
        || !Number.isFinite(heartbeat)) {
        if (attempt < LOCK_READ_RETRIES) continue;
        throw lockError("项目运行锁缺少有效主机身份或进程信息；为避免多设备并发写入，锁未回收。");
      }
      if (record.host_id !== currentHostId) {
        throw lockError("项目运行锁属于其他设备或未知设备；为避免多设备并发写入，锁未回收。");
      }
      // A live PID may have been reused; portable process APIs cannot prove its start time.
      // EPERM and other probe failures are also unknown, so only ESRCH for this host is reclaimable.
      if (processPresence(record.pid) !== "dead") {
        throw lockError("本机项目任务仍在运行或进程状态无法确认；为避免误抢锁，锁未回收。");
      }

      const current = await lstat(lockPath);
      if (current.ino !== identity.ino || current.dev !== identity.dev
        || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs) {
        throw lockError("项目运行锁刚刚更新，请稍后重试。");
      }
      const claim = await acquireReclaimClaim(lockPath, identity, text, currentHostId);
      let recovered = false;
      try {
        const claimedPath = await lstat(lockPath);
        const claimedText = await readFile(lockPath, "utf8");
        if (claimedPath.ino !== identity.ino || claimedPath.dev !== identity.dev
          || claimedPath.size !== identity.size || claimedPath.mtimeMs !== identity.mtimeMs
          || claimedPath.ctimeMs !== identity.ctimeMs || claimedText !== text) {
          throw lockError("项目运行锁在回收认领期间发生变化；请稍后重试。");
        }
        await runnerLockTestHooks.getStore()?.afterStaleLockValidated?.();
        const retired = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
        const renameStaleLock = runnerLockTestHooks.getStore()?.renameStaleLock ?? rename;
        await renameStaleLock(lockPath, retired);
        await unlink(retired).catch(() => undefined);
        const reservation = await open(lockPath, "wx");
        recovered = true;
        await releaseReclaimClaimChain(claim);
        return reservation;
      } finally {
        if (!recovered) await releaseOwnedReclaimClaim(claim).catch(() => undefined);
      }
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

/**
 * Claims recovery for one exact stale lock through an append-only chain of atomic
 * hard-link publications. A crashed claimant is never deleted or replaced: the next
 * process publishes one deterministic successor, so two reclaimers cannot both own
 * the same stale generation. Claim records live in per-user state, not the project.
 */
async function acquireReclaimClaim(
  lockPath: string,
  identity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  lockText: string,
  currentHostId: string,
): Promise<ReclaimClaimLease> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lockPath);
  } catch {
    throw lockError("项目运行锁路径刚刚变化，请稍后重试。");
  }
  const lockKey = createHash("sha256")
    .update(`${canonicalPath}\0${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}\0${lockText}`)
    .digest("hex");
  const directory = path.join(path.dirname(localHostIdFile()), "lock-recovery");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw lockError("无法访问本机锁回收状态目录；为避免并发写入，Core 已停止回收锁。");
  }

  let claimPath = path.join(directory, `${lockKey}.root`);
  let previousToken: string | null = null;
  const entries: ReclaimClaimLease["entries"] = [];
  for (let generation = 0; generation < 1024; generation += 1) {
    const claim: ReclaimClaim = {
      version: 1,
      host_id: currentHostId,
      pid: process.pid,
      token: randomUUID(),
      lock_key: lockKey,
      previous_token: previousToken,
    };
    const tempPath = `${claimPath}.tmp-${process.pid}-${claim.token}`;
    let handle;
    let tempCreated = false;
    let published = false;
    let stagedIdentity: { dev: number; ino: number };
    try {
      handle = await open(tempPath, "wx", 0o600);
      tempCreated = true;
      await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
      await handle.sync();
      const staged = await handle.stat();
      stagedIdentity = { dev: staged.dev, ino: staged.ino };
      await handle.close();
      handle = undefined;
      try {
        await link(tempPath, claimPath);
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } catch (error) {
      if (error instanceof CoreIOError) throw error;
      throw lockError("无法安全登记项目锁回收者；为避免并发写入，项目锁未回收。");
    } finally {
      await handle?.close().catch(() => undefined);
      if (tempCreated) await unlink(tempPath).catch(() => undefined);
    }
    if (published) {
      const entry = { file: claimPath, tempFile: tempPath, claim, identity: stagedIdentity };
      const lease: ReclaimClaimLease = { entries: [...entries, entry], directory, lockKey };
      try {
        await runnerLockTestHooks.getStore()?.afterReclaimClaimPublished?.();
      } catch (error) {
        await releaseOwnedReclaimClaim(lease).catch(() => undefined);
        throw error;
      }
      return lease;
    }

    let existing: unknown;
    let existingIdentity: { dev: number; ino: number };
    try {
      existing = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
      const stat = await lstat(claimPath);
      existingIdentity = { dev: stat.dev, ino: stat.ino };
    } catch {
      throw lockError("项目锁回收状态无效；为避免并发写入，Core 已停止回收锁。");
    }
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw lockError("项目锁回收状态无效；为避免并发写入，Core 已停止回收锁。");
    }
    const existingClaim = existing as Partial<ReclaimClaim>;
    if (existingClaim.version !== 1 || existingClaim.host_id !== currentHostId
      || typeof existingClaim.pid !== "number" || !Number.isSafeInteger(existingClaim.pid) || existingClaim.pid <= 0
      || typeof existingClaim.token !== "string" || !HOST_ID_PATTERN.test(existingClaim.token)
      || existingClaim.lock_key !== lockKey || existingClaim.previous_token !== previousToken) {
      throw lockError("项目锁回收状态与当前设备或锁不匹配；为避免并发写入，Core 已停止回收锁。");
    }
    if (processPresence(existingClaim.pid) !== "dead") {
      throw lockError("另一个进程正在回收此项目锁，或其状态无法确认；请稍后重试。");
    }
    entries.push({
      file: claimPath,
      tempFile: `${claimPath}.tmp-${existingClaim.pid}-${existingClaim.token}`,
      claim: existingClaim as ReclaimClaim,
      identity: existingIdentity,
    });
    previousToken = existingClaim.token;
    claimPath = path.join(directory, `${lockKey}.${previousToken}`);
  }
  throw lockError("项目锁回收历史过长；为避免并发写入，Core 已停止回收锁。");
}

async function releaseOwnedReclaimClaim(lease: ReclaimClaimLease): Promise<void> {
  const owner = lease.entries.at(-1);
  if (!owner) return;
  const successor = path.join(lease.directory, `${lease.lockKey}.${owner.claim.token}`);
  try {
    await lstat(successor);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }

  for (let attempt = 0; attempt <= 10; attempt += 1) {
    try {
      const current = await lstat(owner.file);
      if (current.dev !== owner.identity.dev || current.ino !== owner.identity.ino) return;
      const text = await readFile(owner.file, "utf8");
      const record: unknown = JSON.parse(text);
      if (typeof record !== "object" || record === null || Array.isArray(record)) return;
      const value = record as Partial<ReclaimClaim>;
      if (value.token !== owner.claim.token || value.pid !== process.pid
        || value.host_id !== owner.claim.host_id || value.lock_key !== lease.lockKey
        || value.previous_token !== owner.claim.previous_token) return;
      const latest = await lstat(owner.file);
      if (latest.dev !== owner.identity.dev || latest.ino !== owner.identity.ino) return;
      await unlink(owner.file);
      await unlink(owner.tempFile).catch(() => undefined);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 10) return;
      await wait(200 * (attempt + 1));
    }
  }
}

async function releaseReclaimClaimChain(lease: ReclaimClaimLease): Promise<void> {
  for (const entry of [...lease.entries].reverse()) {
    try {
      const current = await lstat(entry.file);
      if (current.dev !== entry.identity.dev || current.ino !== entry.identity.ino) continue;
      const text = await readFile(entry.file, "utf8");
      const record: unknown = JSON.parse(text);
      if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
      const value = record as Partial<ReclaimClaim>;
      if (value.token !== entry.claim.token || value.pid !== entry.claim.pid
        || value.host_id !== entry.claim.host_id || value.lock_key !== lease.lockKey
        || value.previous_token !== entry.claim.previous_token) continue;
      const latest = await lstat(entry.file);
      if (latest.dev !== entry.identity.dev || latest.ino !== entry.identity.ino) continue;
      await unlink(entry.file).catch(() => undefined);
      await unlink(entry.tempFile).catch(() => undefined);
    } catch {
      // Claim cleanup is best effort after the project lock has been reserved.
    }
  }
}

async function writeLock(lockPath: string, record: LockRecord): Promise<LockIdentity> {
  await atomicWrite(lockPath, `${JSON.stringify(record)}\n`);
  const written = await lstat(lockPath);
  return { ino: written.ino, dev: written.dev };
}

type LockIdentity = { ino: number; dev: number };
type LockUnlinkOptions = { unlinkFile?: (filePath: string) => Promise<void>; wait?: (ms: number) => Promise<void> };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 只移除仍属于本次任务的锁；Windows 上遇到短暂占用时按原子写策略重试。
 * 单回收者认领可以避免其他遵守 Core 锁协议的进程在校验与删除之间换锁；
 * 普通 Node API 没有按 inode 条件 unlink，无法防止非协作同步程序在最后一次 lstat 后替换路径。
 */
export async function unlinkOwnedLock(
  lockPath: string,
  identity: LockIdentity,
  expected?: Pick<LockRecord, "host_id" | "pid" | "started_at">,
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
        if (currentRecord && (currentRecord.host_id !== expected.host_id
          || currentRecord.pid !== expected.pid || currentRecord.started_at !== expected.started_at)) return;
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
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const hostId = await localHostId();
  const started = now().toISOString();
  let handle;
  let identity: LockIdentity | undefined;
  let record: LockRecord | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (!identity || cleaned) return;
    await unlinkOwnedLock(lockPath, identity, record ? { host_id: record.host_id, pid: record.pid, started_at: record.started_at } : undefined);
    cleaned = true;
  };
  try {
    const parent = path.dirname(lockPath);
    await mkdir(parent, { recursive: true });
    handle = await openOrRecover(lockPath, hostId);
    const reservation = await handle.stat();
    identity = { ino: reservation.ino, dev: reservation.dev };
    record = {
      device_id: options.deviceId ?? "unknown",
      device_name: options.deviceName ?? "unknown",
      host_id: hostId,
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

/** @internal Test-only entry point. This is deliberately not re-exported from the Core package. */
export async function withLockForTest<T>(
  project: string,
  fn: () => Promise<T> | T,
  options: LockOptions,
  hooks: RunnerLockTestHooks,
): Promise<T> {
  return runnerLockTestHooks.run(hooks, () => withLock(project, fn, options));
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
