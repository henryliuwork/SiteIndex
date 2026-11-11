import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../io/atomic-write";

const TRANSACTION_VERSION = 2;
const MANIFEST_NAME = "daily-output-transaction.json";
const BACKUP_DIRECTORY = "daily-output-transaction-backups";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface DailyOutputPaths {
  jobLogsDir: string;
  eventsDir: string;
  inventoryLatest: string;
  skus: string;
  dailySummary: string;
}

interface TransactionFile {
  target: string;
  backup: string | null;
  staged: string;
  before_hash: string | null;
  after_hash: string;
}

interface TransactionManifest {
  version: 2;
  files: TransactionFile[];
}

export interface DailyOutputWrite {
  target: string;
  writeTo(destination: string): Promise<void>;
}

export type DailyOutputInputBytes = ReadonlyMap<string, Buffer | null>;

/** Deterministic race gate used by transaction tests; production callers omit it. */
export interface DailyOutputTransactionHooks {
  beforeTargetReplace?(relativeTarget: string): Promise<void>;
}

function transactionError(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelative(relative: string): string {
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative)) {
    throw transactionError("daily 输出事务包含无效的项目相对路径。恢复已停止，请保留事务文件并检查项目数据。");
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw transactionError("daily 输出事务包含越界路径。恢复已停止，请保留事务文件并检查项目数据。");
  }
  return parts.join("/");
}

function projectFile(project: string, relative: string): string {
  return path.resolve(project, ...normalizeRelative(relative).split("/"));
}

/**
 * Reject symlinks and Windows junctions in every existing component below the trusted project root.
 * Node exposes junctions as symbolic links through lstat on Windows. Revalidation immediately before
 * every mutation narrows path substitution races; Node's portable path APIs cannot pin ancestors by handle.
 */
async function safeProjectPath(
  project: string,
  relative: string,
  finalKind: "file" | "directory" | "any" = "any",
): Promise<string> {
  const parts = normalizeRelative(relative).split("/");
  let current = path.resolve(project);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return projectFile(project, relative);
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw transactionError("daily 输出事务路径包含符号链接或目录联接。恢复已停止，请检查项目数据与路径安全性。");
    }
    const isLeaf = index === parts.length - 1;
    if (!isLeaf && !info.isDirectory()) {
      throw transactionError("daily 输出事务路径的中间组件不是普通目录。恢复已停止，请检查项目数据。");
    }
    if (isLeaf && finalKind === "file" && !info.isFile()) {
      throw transactionError("daily 输出事务文件不是普通文件。恢复已停止，请检查项目数据。");
    }
    if (isLeaf && finalKind === "directory" && !info.isDirectory()) {
      throw transactionError("daily 输出事务目录不是普通目录。恢复已停止，请检查项目数据。");
    }
  }
  return current;
}

async function ensureProjectDirectory(project: string, relative: string): Promise<string> {
  let current = "";
  for (const part of normalizeRelative(relative).split("/")) {
    current = current ? `${current}/${part}` : part;
    const absolute = await safeProjectPath(project, current);
    try { await mkdir(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await safeProjectPath(project, current, "directory");
  }
  return projectFile(project, relative);
}

async function safeAtomicWrite(
  project: string,
  relative: string,
  data: string | Uint8Array,
  expectedCurrentHash?: string | null,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  const parentRelative = path.posix.dirname(normalizeRelative(relative));
  if (parentRelative !== ".") await ensureProjectDirectory(project, parentRelative);
  const filePath = await safeProjectPath(project, relative, "file");
  await atomicWrite(filePath, data, async () => {
    await beforeReplace?.();
    await safeProjectPath(project, relative, "file");
    if (expectedCurrentHash !== undefined && await currentHash(project, relative) !== expectedCurrentHash) {
      throw transactionError("daily 输出文件在替换前被其他进程修改。为保护该文件，写入已停止。");
    }
    // This is the narrowest portable guard available before path-based rename. Node has no
    // cross-platform compare-and-swap rename; an uncooperative writer can still race the final syscall.
  });
}

async function safeUnlink(project: string, relative: string, expectedCurrentHash?: string | null): Promise<void> {
  const filePath = await safeProjectPath(project, relative, "file");
  await safeProjectPath(project, relative, "file");
  if (expectedCurrentHash !== undefined && await currentHash(project, relative) !== expectedCurrentHash) {
    throw transactionError("daily 输出文件在删除前被其他进程修改。为保护该文件，删除已停止。");
  }
  // unlink is likewise path based and cannot atomically compare the current bytes on every platform.
  await unlink(filePath);
}

function relativeProjectFile(project: string, filePath: string): string {
  const relative = path.relative(project, path.resolve(filePath)).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw transactionError("daily 输出事务目标路径必须位于项目目录内。");
  }
  return normalizeRelative(relative);
}

function manifestRelative(paths: DailyOutputPaths): string {
  return `${normalizeRelative(paths.jobLogsDir)}/${MANIFEST_NAME}`;
}

function backupDirectoryRelative(paths: DailyOutputPaths): string {
  return `${normalizeRelative(paths.jobLogsDir)}/${BACKUP_DIRECTORY}`;
}

function artifactRelative(paths: DailyOutputPaths, index: number, extension: "before" | "after"): string {
  return `${backupDirectoryRelative(paths)}/${index}.${extension}`;
}

function expectedTargets(paths: DailyOutputPaths, eventTarget: string): string[] {
  return [
    normalizeRelative(eventTarget),
    normalizeRelative(paths.inventoryLatest),
    normalizeRelative(paths.skus),
    normalizeRelative(paths.dailySummary),
  ];
}

async function readBytesIfPresent(project: string, relative: string): Promise<Buffer | null> {
  const filePath = await safeProjectPath(project, relative, "file");
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw transactionError("daily 输出事务目标不是普通文件。恢复已停止，请检查项目数据。");
    }
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function currentHash(project: string, relative: string): Promise<string | null> {
  const bytes = await readBytesIfPresent(project, relative);
  return bytes === null ? null : sha256(bytes);
}

/** Read the exact transaction-target bytes used as the starting point for daily business calculations. */
export async function captureDailyOutputInputBytes(
  projectPath: string,
  relativePaths: readonly string[],
): Promise<Map<string, Buffer | null>> {
  const project = path.resolve(projectPath);
  const inputs = new Map<string, Buffer | null>();
  for (const relativePath of relativePaths) {
    const target = normalizeRelative(relativePath);
    inputs.set(target, await readBytesIfPresent(project, target));
  }
  return inputs;
}

/** Fail if any output used to calculate daily results changed after its initial byte snapshot. */
export async function assertDailyOutputInputsUnchanged(
  projectPath: string,
  inputs: DailyOutputInputBytes,
): Promise<void> {
  const project = path.resolve(projectPath);
  for (const [target, expected] of inputs) {
    const actual = await currentHash(project, normalizeRelative(target));
    const expectedHash = expected === null ? null : sha256(expected);
    if (actual !== expectedHash) {
      throw transactionError("daily 计算期间库存文件已被其他进程修改。为保护用户数据，本次同步已停止，请重新运行 daily。请检查项目数据后重试。");
    }
  }
}

async function assertPrivateArtifactDirectory(project: string, relative: string, expectedNames?: ReadonlySet<string>): Promise<string[]> {
  const directory = await safeProjectPath(project, relative, "directory");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw transactionError("daily 输出事务备份目录不是安全的普通目录。恢复已停止，请保留事务材料并检查项目数据。");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name);
  for (const entry of entries) {
    if (!/^[0-3]\.(before|after)$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw transactionError("daily 输出事务备份目录包含未知项目。恢复已停止，请保留事务材料并检查项目数据。");
    }
  }
  if (expectedNames && (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name)))) {
    throw transactionError("daily 输出事务备份不完整或包含多余文件。恢复已停止，请保留事务材料并检查项目数据。");
  }
  return names;
}

async function cleanupOrphanArtifacts(project: string, paths: DailyOutputPaths): Promise<void> {
  const relative = backupDirectoryRelative(paths);
  const names = await assertPrivateArtifactDirectory(project, relative);
  await removeArtifactDirectory(project, relative, names);
}

async function removeArtifactDirectory(project: string, relative: string, names: readonly string[]): Promise<void> {
  for (const name of names) await safeUnlink(project, `${relative}/${name}`);
  if (names.length) await rmdir(await safeProjectPath(project, relative, "directory"));
}

async function cleanupArtifactDirectory(project: string, relative: string, names: readonly string[]): Promise<void> {
  try { await removeArtifactDirectory(project, relative, names); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
    // The data commit or rollback is already complete; leave private artifacts for the next guarded cleanup.
  }
}

async function manifestExists(project: string, relative: string): Promise<boolean> {
  try {
    await lstat(await safeProjectPath(project, relative, "file"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(project: string, relative: string): Promise<{ exists: false } | { exists: true; value: unknown; bytes: Buffer }> {
  try {
    const manifestPath = await safeProjectPath(project, relative, "file");
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw transactionError("daily 输出事务记录不是安全的普通文件。恢复已停止，请保留事务材料并检查项目数据。");
    }
    const bytes = await readFile(manifestPath);
    return { exists: true, value: JSON.parse(bytes.toString("utf8")) as unknown, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    if (error instanceof SyntaxError) {
      throw transactionError("daily 输出事务记录损坏，已停止同步以避免覆盖不一致的数据。", error);
    }
    throw error;
  }
}

function validateManifestShape(value: unknown, paths: DailyOutputPaths): TransactionManifest {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "files,version"
    || value.version !== TRANSACTION_VERSION || !Array.isArray(value.files) || value.files.length !== 4) {
    throw transactionError("daily 输出事务记录不完整或版本无效。恢复已停止，请保留事务材料并检查项目数据。");
  }
  const files: TransactionFile[] = [];
  for (const item of value.files) {
    if (!isRecord(item)
      || Object.keys(item).sort().join(",") !== "after_hash,backup,before_hash,staged,target"
      || typeof item.target !== "string"
      || !(typeof item.backup === "string" || item.backup === null)
      || typeof item.staged !== "string"
      || !(typeof item.before_hash === "string" || item.before_hash === null)
      || !isSha256(item.after_hash)
      || (item.before_hash !== null && !isSha256(item.before_hash))) {
      throw transactionError("daily 输出事务文件清单无效。恢复已停止，请保留事务材料并检查项目数据。");
    }
    files.push({
      target: normalizeRelative(item.target),
      backup: item.backup === null ? null : normalizeRelative(item.backup),
      staged: normalizeRelative(item.staged),
      before_hash: item.before_hash,
      after_hash: item.after_hash,
    });
  }

  const eventPrefix = `${normalizeRelative(paths.eventsDir)}/`;
  const eventTargets = files.filter((file) => file.target.startsWith(eventPrefix));
  if (eventTargets.length !== 1) {
    throw transactionError("daily 输出事务事件文件路径无效。恢复已停止，请保留事务材料并检查项目数据。");
  }
  const eventName = eventTargets[0]!.target.slice(eventPrefix.length);
  if (!/^\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(eventName)) {
    throw transactionError("daily 输出事务事件文件月份无效。恢复已停止，请保留事务材料并检查项目数据。");
  }
  const targets = expectedTargets(paths, `${paths.eventsDir}/${eventName}`);
  if (new Set(targets).size !== 4 || files.some((file, index) => file.target !== targets[index])) {
    throw transactionError("daily 输出事务必须按固定顺序包含四个库存输出文件。恢复已停止，请保留事务材料并检查项目数据。");
  }

  files.forEach((file, index) => {
    const expectedStage = artifactRelative(paths, index, "after");
    const expectedBackup = file.before_hash === null ? null : artifactRelative(paths, index, "before");
    if (file.staged !== expectedStage || file.backup !== expectedBackup || (file.before_hash === null) !== (file.backup === null)) {
      throw transactionError("daily 输出事务备份路径与清单顺序不符。恢复已停止，请保留事务材料并检查项目数据。");
    }
  });
  return { version: TRANSACTION_VERSION, files, };
}

async function validateArtifacts(
  project: string,
  paths: DailyOutputPaths,
  manifest: TransactionManifest,
): Promise<{ backups: (Buffer | null)[]; staged: Buffer[] }> {
  const directory = backupDirectoryRelative(paths);
  const expectedNames = new Set<string>();
  manifest.files.forEach((file, index) => {
    expectedNames.add(`${index}.after`);
    if (file.backup !== null) expectedNames.add(`${index}.before`);
  });
  await assertPrivateArtifactDirectory(project, directory, expectedNames);

  const backups: (Buffer | null)[] = [];
  const staged: Buffer[] = [];
  for (const file of manifest.files) {
    const afterBytes = await readBytesIfPresent(project, file.staged);
    if (afterBytes === null || sha256(afterBytes) !== file.after_hash) {
      throw transactionError("daily 输出事务的暂存文件缺失或校验失败。恢复已停止，请保留事务材料并检查项目数据。");
    }
    staged.push(afterBytes);
    if (file.before_hash === null) {
      backups.push(null);
      continue;
    }
    if (file.backup === null) {
      throw transactionError("daily 输出事务缺少旧文件备份路径。恢复已停止，请保留事务材料并检查项目数据。");
    }
    const beforeBytes = await readBytesIfPresent(project, file.backup);
    if (beforeBytes === null || sha256(beforeBytes) !== file.before_hash) {
      throw transactionError("daily 输出事务的旧文件备份缺失或校验失败。恢复已停止，请保留事务材料并检查项目数据。");
    }
    backups.push(beforeBytes);
  }
  return { backups, staged };
}

function isBeforeOrAfter(hash: string | null, file: TransactionFile): boolean {
  if (hash === file.after_hash) return true;
  return hash === file.before_hash;
}

function expectedArtifactNames(manifest: TransactionManifest): Set<string> {
  const names = new Set<string>();
  manifest.files.forEach((file, index) => {
    names.add(`${index}.after`);
    if (file.backup !== null) names.add(`${index}.before`);
  });
  return names;
}

/** Roll back interrupted daily output only after every path and hash has been validated. */
export async function recoverDailyOutputTransaction(
  projectPath: string,
  paths: DailyOutputPaths,
  hooks?: DailyOutputTransactionHooks,
): Promise<void> {
  const project = path.resolve(projectPath);
  const relativeManifest = manifestRelative(paths);
  const manifestResult = await readManifest(project, relativeManifest);
  if (!manifestResult.exists) {
    await cleanupOrphanArtifacts(project, paths);
    return;
  }

  const manifest = validateManifestShape(manifestResult.value, paths);
  const artifacts = await validateArtifacts(project, paths, manifest);
  for (const file of manifest.files) {
    const hash = await currentHash(project, file.target);
    if (!isBeforeOrAfter(hash, file)) {
      throw transactionError("daily 输出文件在事务中断后被其他进程修改。为保护该文件，恢复已停止；请保留事务备份并检查项目数据。");
    }
  }

  // The full transaction is validated above before the first write. Recheck each target
  // immediately before restoring it so an external writer is never silently overwritten.
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index]!;
    const current = await currentHash(project, file.target);
    if (!isBeforeOrAfter(current, file)) {
      throw transactionError("daily 输出文件在恢复过程中被其他进程修改。已停止并保留事务备份，请检查项目数据。");
    }
    if (current === file.before_hash) continue;
    const backup = artifacts.backups[index];
    if (file.before_hash === null) {
      await safeUnlink(project, file.target, current);
    } else if (backup !== null && backup !== undefined) {
      await safeAtomicWrite(project, file.target, backup, current, async () => { await hooks?.beforeTargetReplace?.(file.target); });
    } else {
      throw transactionError("daily 输出事务旧文件备份不可用。恢复已停止，请保留事务材料并检查项目数据。");
    }
  }

  for (const file of manifest.files) {
    if (await currentHash(project, file.target) !== file.before_hash) {
      throw transactionError("daily 输出事务回滚后的完整性校验失败。恢复材料已保留，请检查项目数据。");
    }
  }
  const backupDirectory = backupDirectoryRelative(paths);
  const names = await assertPrivateArtifactDirectory(project, backupDirectory, expectedArtifactNames(manifest));
  await safeUnlink(project, relativeManifest, sha256(manifestResult.bytes));
  await cleanupArtifactDirectory(project, backupDirectory, names);
}

export interface DailyOutputTransactionOverlay {
  /** Absolute target path to the pre-transaction bytes; null means the file did not exist yet. */
  files: ReadonlyMap<string, Buffer | null>;
  /** Hash of the journal bytes; changes whenever a different transaction becomes visible. */
  signature: string;
}

/** Read the last committed view without recovering or writing files. */
export async function readDailyOutputTransactionOverlay(
  projectPath: string,
  paths: DailyOutputPaths,
): Promise<DailyOutputTransactionOverlay | null> {
  const project = path.resolve(projectPath);
  const relativeManifest = manifestRelative(paths);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await readManifest(project, relativeManifest);
    if (!result.exists) return null;
    try {
      const manifest = validateManifestShape(result.value, paths);
      const artifacts = await validateArtifacts(project, paths, manifest);
      const files = new Map<string, Buffer | null>();
      for (let index = 0; index < manifest.files.length; index += 1) {
        const item = manifest.files[index]!;
        if (!isBeforeOrAfter(await currentHash(project, item.target), item)) {
          throw transactionError("daily 输出文件在事务期间被其他进程修改。读取已停止，请保留事务材料并检查项目数据。");
        }
        files.set(projectFile(project, item.target), artifacts.backups[index] ?? null);
      }
      return { files, signature: sha256(result.bytes) };
    } catch (error) {
      const latest = await readManifest(project, relativeManifest);
      if (!latest.exists || sha256(latest.bytes) !== sha256(result.bytes)) continue;
      throw error;
    }
  }
  throw transactionError("daily 输出事务正在清理，无法取得一致快照，请稍后重试。");
}

/** Stage all four outputs, record hashes, then atomically replace each target under the project lock. */
export async function persistDailyOutputTransaction(
  projectPath: string,
  paths: DailyOutputPaths,
  writes: readonly DailyOutputWrite[],
  hooks?: DailyOutputTransactionHooks,
  expectedInputBytes?: DailyOutputInputBytes,
): Promise<void> {
  const project = path.resolve(projectPath);
  await recoverDailyOutputTransaction(project, paths, hooks);
  const eventEntry = writes[0];
  if (!eventEntry) throw transactionError("daily 输出事务缺少库存事件文件。");
  const eventTarget = relativeProjectFile(project, eventEntry.target);
  const eventPrefix = `${normalizeRelative(paths.eventsDir)}/`;
  if (!eventTarget.startsWith(eventPrefix)) {
    throw transactionError("daily 输出事务事件文件不在固定 events 目录中。");
  }
  const targetFiles = expectedTargets(paths, eventTarget);
  if (targetFiles[0] !== eventTarget) {
    throw transactionError("daily 输出事务事件文件不在固定 events 目录中。");
  }
  const eventName = eventTarget.slice(`${normalizeRelative(paths.eventsDir)}/`.length);
  if (!/^\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(eventName)) {
    throw transactionError("daily 输出事务事件文件月份无效。");
  }
  if (writes.length !== 4 || writes.some((entry, index) => relativeProjectFile(project, entry.target) !== targetFiles[index])) {
    throw transactionError("daily 输出事务只能按固定顺序写入事件、库存、SKU 与汇总文件。");
  }
  if (expectedInputBytes && (expectedInputBytes.size !== targetFiles.length
    || targetFiles.some((target) => !expectedInputBytes.has(target)))) {
    throw transactionError("daily 初始输入快照与固定输出清单不一致；为保护用户数据，本次同步已停止。");
  }

  const backupDirRelative = backupDirectoryRelative(paths);
  const backupDir = await ensureProjectDirectory(project, backupDirRelative);
  const files: TransactionFile[] = [];
  try {
    for (const [index, entry] of writes.entries()) {
      const target = targetFiles[index]!;
      const before = await readBytesIfPresent(project, target);
      if (expectedInputBytes) {
        const expected = expectedInputBytes.get(target)!;
        if ((before === null ? null : sha256(before)) !== (expected === null ? null : sha256(expected))) {
          throw transactionError("daily 首次读取后目标文件已被其他进程修改。未覆盖该文件，请检查项目数据并重新运行 daily。");
        }
      }
      const stagedRelative = artifactRelative(paths, index, "after");
      const stagedPath = projectFile(project, stagedRelative);
      await safeProjectPath(project, stagedRelative, "file");
      await entry.writeTo(stagedPath);
      const after = await readBytesIfPresent(project, stagedRelative);
      if (after === null) throw transactionError("daily 输出事务暂存文件未生成。");

      let backupRelative: string | null = null;
      if (before !== null) {
        backupRelative = artifactRelative(paths, index, "before");
        await safeAtomicWrite(project, backupRelative, before, null);
      }
      files.push({
        target,
        backup: backupRelative,
        staged: stagedRelative,
        before_hash: before === null ? null : sha256(before),
        after_hash: sha256(after),
      });
    }

    for (const file of files) {
      if (await currentHash(project, file.target) !== file.before_hash) {
        throw transactionError("daily 输出文件在写入前已被其他进程修改。未覆盖该文件，请重试并检查项目数据。");
      }
    }

    const manifest: TransactionManifest = { version: TRANSACTION_VERSION, files };
    // Verify every staged and backup byte before making the recovery journal visible.
    const artifacts = await validateArtifacts(project, paths, manifest);
    const relativeManifest = manifestRelative(paths);
    const manifestBytes = `${JSON.stringify(manifest)}\n`;
    await safeAtomicWrite(project, relativeManifest, manifestBytes, null);
    try {
      for (const [index, file] of files.entries()) {
        if (await currentHash(project, file.target) !== file.before_hash) {
          throw transactionError("daily 输出文件在提交期间被其他进程修改。为保护该文件，daily 已停止。");
        }
        const staged = artifacts.staged[index];
        if (!staged || sha256(staged) !== file.after_hash) {
          throw transactionError("daily 输出事务的暂存内容校验失败。");
        }
        await safeAtomicWrite(project, file.target, staged, file.before_hash, async () => { await hooks?.beforeTargetReplace?.(file.target); });
        if (await currentHash(project, file.target) !== file.after_hash) {
          throw transactionError("daily 输出文件提交后的校验失败。");
        }
      }
      for (const file of files) {
        if (await currentHash(project, file.target) !== file.after_hash) {
          throw transactionError("daily 输出在事务提交期间被其他进程修改。");
        }
      }
      const artifactNames = await assertPrivateArtifactDirectory(project, backupDirRelative, expectedArtifactNames(manifest));
      await safeUnlink(project, relativeManifest, sha256(Buffer.from(manifestBytes)));
      await cleanupArtifactDirectory(project, backupDirRelative, artifactNames);
    } catch (writeError) {
      try {
        await recoverDailyOutputTransaction(project, paths, hooks);
      } catch (recoveryError) {
        throw transactionError(
          `daily 输出失败，自动恢复也未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}。恢复材料已保留，请检查项目数据。`,
          writeError,
        );
      }
      throw transactionError(`daily 输出失败，已恢复写入前的数据：${writeError instanceof Error ? writeError.message : String(writeError)}`, writeError);
    }
  } catch (error) {
    if (!await manifestExists(project, manifestRelative(paths))) {
      await cleanupOrphanArtifacts(project, paths).catch(() => undefined);
    }
    throw error;
  }
}
