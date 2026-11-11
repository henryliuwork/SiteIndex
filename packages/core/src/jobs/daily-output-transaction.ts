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

async function readBytesIfPresent(filePath: string): Promise<Buffer | null> {
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

async function currentHash(filePath: string): Promise<string | null> {
  const bytes = await readBytesIfPresent(filePath);
  return bytes === null ? null : sha256(bytes);
}

async function assertPrivateArtifactDirectory(directory: string, expectedNames?: ReadonlySet<string>): Promise<string[]> {
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
  const directory = projectFile(project, backupDirectoryRelative(paths));
  const names = await assertPrivateArtifactDirectory(directory);
  await removeArtifactDirectory(directory, names);
}

async function removeArtifactDirectory(directory: string, names: readonly string[]): Promise<void> {
  for (const name of names) await unlink(path.join(directory, name));
  if (names.length) await rmdir(directory);
}

async function cleanupArtifactDirectory(directory: string, names: readonly string[]): Promise<void> {
  try { await removeArtifactDirectory(directory, names); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
    // The data commit or rollback is already complete; leave private artifacts for the next guarded cleanup.
  }
}

async function manifestExists(manifestPath: string): Promise<boolean> {
  try {
    await lstat(manifestPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(manifestPath: string): Promise<unknown | null> {
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw transactionError("daily 输出事务记录不是安全的普通文件。恢复已停止，请保留事务材料并检查项目数据。");
    }
    return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
  const directory = projectFile(project, backupDirectoryRelative(paths));
  const expectedNames = new Set<string>();
  manifest.files.forEach((file, index) => {
    expectedNames.add(`${index}.after`);
    if (file.backup !== null) expectedNames.add(`${index}.before`);
  });
  await assertPrivateArtifactDirectory(directory, expectedNames);

  const backups: (Buffer | null)[] = [];
  const staged: Buffer[] = [];
  for (const file of manifest.files) {
    const afterBytes = await readBytesIfPresent(projectFile(project, file.staged));
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
    const beforeBytes = await readBytesIfPresent(projectFile(project, file.backup));
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
export async function recoverDailyOutputTransaction(projectPath: string, paths: DailyOutputPaths): Promise<void> {
  const project = path.resolve(projectPath);
  const manifestPath = projectFile(project, manifestRelative(paths));
  const raw = await readManifest(manifestPath);
  if (raw === null) {
    await cleanupOrphanArtifacts(project, paths);
    return;
  }

  const manifest = validateManifestShape(raw, paths);
  const artifacts = await validateArtifacts(project, paths, manifest);
  for (const file of manifest.files) {
    const hash = await currentHash(projectFile(project, file.target));
    if (!isBeforeOrAfter(hash, file)) {
      throw transactionError("daily 输出文件在事务中断后被其他进程修改。为保护该文件，恢复已停止；请保留事务备份并检查项目数据。");
    }
  }

  // The full transaction is validated above before the first write. Recheck each target
  // immediately before restoring it so an external writer is never silently overwritten.
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index]!;
    const targetPath = projectFile(project, file.target);
    const current = await currentHash(targetPath);
    if (!isBeforeOrAfter(current, file)) {
      throw transactionError("daily 输出文件在恢复过程中被其他进程修改。已停止并保留事务备份，请检查项目数据。");
    }
    if (current === file.before_hash) continue;
    const backup = artifacts.backups[index];
    if (file.before_hash === null) {
      await unlink(targetPath);
    } else if (backup !== null && backup !== undefined) {
      await atomicWrite(targetPath, backup);
    } else {
      throw transactionError("daily 输出事务旧文件备份不可用。恢复已停止，请保留事务材料并检查项目数据。");
    }
  }

  for (const file of manifest.files) {
    if (await currentHash(projectFile(project, file.target)) !== file.before_hash) {
      throw transactionError("daily 输出事务回滚后的完整性校验失败。恢复材料已保留，请检查项目数据。");
    }
  }
  const backupDirectory = projectFile(project, backupDirectoryRelative(paths));
  const names = await assertPrivateArtifactDirectory(backupDirectory, expectedArtifactNames(manifest));
  await unlink(manifestPath);
  await cleanupArtifactDirectory(backupDirectory, names);
}

/** Stage all four outputs, record hashes, then atomically replace each target under the project lock. */
export async function persistDailyOutputTransaction(
  projectPath: string,
  paths: DailyOutputPaths,
  writes: readonly DailyOutputWrite[],
): Promise<void> {
  const project = path.resolve(projectPath);
  await recoverDailyOutputTransaction(project, paths);
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

  const backupDirRelative = backupDirectoryRelative(paths);
  const backupDir = projectFile(project, backupDirRelative);
  await mkdir(backupDir, { recursive: true });
  const files: TransactionFile[] = [];
  try {
    for (const [index, entry] of writes.entries()) {
      const target = targetFiles[index]!;
      const targetPath = projectFile(project, target);
      const before = await readBytesIfPresent(targetPath);
      const stagedRelative = artifactRelative(paths, index, "after");
      const stagedPath = projectFile(project, stagedRelative);
      await entry.writeTo(stagedPath);
      const after = await readBytesIfPresent(stagedPath);
      if (after === null) throw transactionError("daily 输出事务暂存文件未生成。");

      let backupRelative: string | null = null;
      if (before !== null) {
        backupRelative = artifactRelative(paths, index, "before");
        await atomicWrite(projectFile(project, backupRelative), before);
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
      if (await currentHash(projectFile(project, file.target)) !== file.before_hash) {
        throw transactionError("daily 输出文件在写入前已被其他进程修改。未覆盖该文件，请重试并检查项目数据。");
      }
    }

    const manifest: TransactionManifest = { version: TRANSACTION_VERSION, files };
    // Verify every staged and backup byte before making the recovery journal visible.
    const artifacts = await validateArtifacts(project, paths, manifest);
    const manifestPath = projectFile(project, manifestRelative(paths));
    await atomicWrite(manifestPath, `${JSON.stringify(manifest)}\n`);
    try {
      for (const [index, file] of files.entries()) {
        const target = projectFile(project, file.target);
        if (await currentHash(target) !== file.before_hash) {
          throw transactionError("daily 输出文件在提交期间被其他进程修改。为保护该文件，daily 已停止。");
        }
        const staged = artifacts.staged[index];
        if (!staged || sha256(staged) !== file.after_hash) {
          throw transactionError("daily 输出事务的暂存内容校验失败。");
        }
        await atomicWrite(target, staged);
        if (await currentHash(target) !== file.after_hash) {
          throw transactionError("daily 输出文件提交后的校验失败。");
        }
      }
      for (const file of files) {
        if (await currentHash(projectFile(project, file.target)) !== file.after_hash) {
          throw transactionError("daily 输出在事务提交期间被其他进程修改。");
        }
      }
      const artifactNames = await assertPrivateArtifactDirectory(backupDir, expectedArtifactNames(manifest));
      await unlink(manifestPath);
      await cleanupArtifactDirectory(backupDir, artifactNames);
    } catch (writeError) {
      try {
        await recoverDailyOutputTransaction(project, paths);
      } catch (recoveryError) {
        throw transactionError(
          `daily 输出失败，自动恢复也未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}。恢复材料已保留，请检查项目数据。`,
          writeError,
        );
      }
      throw transactionError(`daily 输出失败，已恢复写入前的数据：${writeError instanceof Error ? writeError.message : String(writeError)}`, writeError);
    }
  } catch (error) {
    const manifestPath = projectFile(project, manifestRelative(paths));
    if (!await manifestExists(manifestPath)) {
      await cleanupOrphanArtifacts(project, paths).catch(() => undefined);
    }
    throw error;
  }
}
