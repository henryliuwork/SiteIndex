import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../io/atomic-write";

const TRANSACTION_VERSION = 1;
const MANIFEST_NAME = "daily-output-transaction.json";
const BACKUP_DIRECTORY = "daily-output-transaction-backups";

interface TransactionFile {
  target: string;
  backup: string | null;
}

interface TransactionManifest {
  version: 1;
  files: TransactionFile[];
}

export interface DailyOutputWrite {
  target: string;
  write(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeProjectFile(project: string, filePath: string): string {
  const relative = path.relative(project, path.resolve(filePath));
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("daily 输出事务目标路径必须位于项目目录内。");
  }
  return relative;
}

function resolveProjectFile(project: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error("daily 输出事务路径无效。");
  const target = path.resolve(project, relative);
  relativeProjectFile(project, target);
  return target;
}

function manifestFile(project: string, jobLogsDir: string): string {
  return path.join(project, jobLogsDir, MANIFEST_NAME);
}

function backupDirectory(project: string, jobLogsDir: string): string {
  return path.join(project, jobLogsDir, BACKUP_DIRECTORY);
}

async function readManifest(filePath: string): Promise<TransactionManifest | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("daily 输出事务记录损坏，已停止同步以避免覆盖不一致的数据。", { cause: error });
  }
  if (!isRecord(value) || value.version !== TRANSACTION_VERSION || !Array.isArray(value.files)) {
    throw new Error("daily 输出事务记录版本无效，已停止同步以避免覆盖不一致的数据。");
  }
  const files: TransactionFile[] = [];
  for (const item of value.files) {
    if (!isRecord(item) || typeof item.target !== "string" || !(typeof item.backup === "string" || item.backup === null)) {
      throw new Error("daily 输出事务文件清单无效，已停止同步以避免覆盖不一致的数据。");
    }
    files.push({ target: item.target, backup: item.backup });
  }
  return { version: TRANSACTION_VERSION, files };
}

/** Restore the pre-daily snapshots whenever a previous run stopped before its output commit. */
export async function recoverDailyOutputTransaction(projectPath: string, jobLogsDir: string): Promise<void> {
  const project = path.resolve(projectPath);
  const manifestPath = manifestFile(project, jobLogsDir);
  const manifest = await readManifest(manifestPath);
  if (!manifest) {
    await rm(backupDirectory(project, jobLogsDir), { recursive: true, force: true });
    return;
  }

  for (const file of manifest.files) {
    const target = resolveProjectFile(project, file.target);
    if (file.backup === null) {
      try {
        await unlink(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    const backup = resolveProjectFile(project, file.backup);
    await atomicWrite(target, await readFile(backup));
  }

  await unlink(manifestPath);
  await rm(backupDirectory(project, jobLogsDir), { recursive: true, force: true });
}

/**
 * Back up each target, then write a manifest before replacing any output. A restart can
 * restore all old files if any write or process is interrupted before the manifest is removed.
 */
export async function persistDailyOutputTransaction(
  projectPath: string,
  jobLogsDir: string,
  writes: readonly DailyOutputWrite[],
): Promise<void> {
  const project = path.resolve(projectPath);
  await recoverDailyOutputTransaction(project, jobLogsDir);
  const backups = backupDirectory(project, jobLogsDir);
  await rm(backups, { recursive: true, force: true });
  await mkdir(backups, { recursive: true });

  const files: TransactionFile[] = [];
  for (const [index, entry] of writes.entries()) {
    const target = path.resolve(entry.target);
    const relativeTarget = relativeProjectFile(project, target);
    let previous: Buffer;
    try {
      previous = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        files.push({ target: relativeTarget, backup: null });
        continue;
      }
      throw error;
    }
    const relativeBackup = path.join(jobLogsDir, BACKUP_DIRECTORY, `${index}.bak`);
    await atomicWrite(resolveProjectFile(project, relativeBackup), previous);
    files.push({ target: relativeTarget, backup: relativeBackup });
  }

  const transaction: TransactionManifest = { version: TRANSACTION_VERSION, files };
  await atomicWrite(manifestFile(project, jobLogsDir), `${JSON.stringify(transaction)}\n`);
  for (const entry of writes) await entry.write();

  await unlink(manifestFile(project, jobLogsDir));
  await rm(backups, { recursive: true, force: true });
}
