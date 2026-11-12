import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { EdmSkuIndexExportResult, SiteIndexError } from "@siteindex/shared";

export interface RenderedEdmSkuIndex {
  content: string;
  sku_count: number;
  missing_image_count: number;
}

export interface EdmIndexSaveDialogOptions {
  title: string;
  defaultPath: string;
  properties: ("showOverwriteConfirmation")[];
  filters: { name: string; extensions: string[] }[];
}

export interface EdmIndexSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface EdmIndexSaveAsOptions {
  defaultPath: string;
  showSaveDialog(options: EdmIndexSaveDialogOptions): Promise<EdmIndexSaveDialogResult>;
  createHardLink?: typeof link;
  /** Deterministic race injection for tests; production callers leave this unset. */
  beforeTemporaryOpenForTest?: () => Promise<void>;
  /** Deterministic race injection after opening the file but before its first payload write. */
  beforeTemporaryWriteForTest?: () => Promise<void>;
  /** Deterministic race injection after payload sync but before publishing the target. */
  beforeTemporaryPublishForTest?: () => Promise<void>;
  /** Deterministic cleanup failure injection for tests; production callers leave this unset. */
  truncateTemporaryForTest?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
}

export function resolveEdmIndexDefaultPath(options: {
  getDownloadsPath(): string;
  getHomePath(): string;
  fileName: string;
}): string {
  let directory: string;
  try {
    directory = options.getDownloadsPath();
  } catch {
    try {
      directory = options.getHomePath();
    } catch {
      return options.fileName;
    }
  }
  return path.join(directory, options.fileName);
}

interface DirectorySnapshot {
  path: string;
  dev: number;
  ino: number;
}

function saveError(
  code: SiteIndexError["code"],
  message: string,
  detail: string,
): SiteIndexError {
  return { code, message, detail };
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasReparsePoint(stats: Awaited<ReturnType<typeof lstat>>): boolean {
  const attributes = (stats as typeof stats & { attributes?: number }).attributes;
  return stats.isSymbolicLink() || (typeof attributes === "number" && (attributes & 0x400) !== 0);
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
}

async function snapshotDirectory(directoryPath: string): Promise<DirectorySnapshot> {
  const resolvedPath = path.resolve(directoryPath);
  const canonicalPath = await realpath(resolvedPath);
  await assertNoReparsePointComponents(canonicalPath);
  const [resolvedStats, stats] = await Promise.all([lstat(resolvedPath), lstat(canonicalPath)]);
  if (!sameIdentity(resolvedStats, stats)) throw new Error("unsafe-directory-alias");
  if (hasReparsePoint(stats) || !stats.isDirectory() || stats.ino === 0) throw new Error("unsafe-directory-identity");
  return { path: canonicalPath, dev: stats.dev, ino: stats.ino };
}

async function assertNoReparsePointComponents(absolutePath: string): Promise<void> {
  const { root } = path.parse(absolutePath);
  const segments = absolutePath.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (hasReparsePoint(stats)) throw new Error("unsafe-reparse-point-component");
  }
}

async function verifyDirectorySnapshot(snapshot: DirectorySnapshot): Promise<void> {
  await assertNoReparsePointComponents(snapshot.path);
  const canonicalPath = await realpath(snapshot.path);
  const stats = await lstat(canonicalPath);
  if (
    !samePath(canonicalPath, snapshot.path) ||
    hasReparsePoint(stats) ||
    !stats.isDirectory() ||
    !sameIdentity(snapshot, stats)
  ) {
    throw new Error("directory-identity-changed");
  }
}

async function verifyTemporaryLocation(
  parentSnapshot: DirectorySnapshot,
  temporaryPath: string,
  temporaryIdentity: { dev: number; ino: number },
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const [openedStats, pathStats, canonicalTemporaryPath] = await Promise.all([
    handle.stat(),
    lstat(temporaryPath),
    realpath(temporaryPath),
  ]);
  const expectedTemporaryPath = path.join(parentSnapshot.path, path.basename(temporaryPath));
  const currentParentStats = await lstat(parentSnapshot.path);
  if (
    !openedStats.isFile() ||
    !pathStats.isFile() ||
    hasReparsePoint(pathStats) ||
    hasReparsePoint(currentParentStats) ||
    !currentParentStats.isDirectory() ||
    !sameIdentity(parentSnapshot, currentParentStats) ||
    !sameIdentity(temporaryIdentity, openedStats) ||
    !sameIdentity(temporaryIdentity, pathStats) ||
    !samePath(canonicalTemporaryPath, expectedTemporaryPath)
  ) {
    throw new Error("temporary-file-location-changed");
  }
}

async function readExistingRegularFile(
  targetPath: string,
  expectedContent: Buffer,
): Promise<{ matches: boolean }> {
  const pathStats = await lstat(targetPath);
  if (hasReparsePoint(pathStats) || !pathStats.isFile() || pathStats.ino === 0) {
    throw new Error("unsafe-existing-target");
  }
  const handle = await open(targetPath, "r");
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || !sameIdentity(pathStats, openedStats)) throw new Error("target-identity-changed");
    let matches = openedStats.size === expectedContent.byteLength;
    if (matches && expectedContent.byteLength > 0) {
      const content = Buffer.allocUnsafe(expectedContent.byteLength);
      let offset = 0;
      while (offset < content.byteLength) {
        const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
        if (bytesRead === 0) {
          matches = false;
          break;
        }
        offset += bytesRead;
      }
      if (matches) matches = content.equals(expectedContent);
    }
    const finalPathStats = await lstat(targetPath);
    if (hasReparsePoint(finalPathStats) || !finalPathStats.isFile() || !sameIdentity(openedStats, finalPathStats)) {
      throw new Error("target-identity-changed");
    }
    return { matches };
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export function createEdmIndexSaveAs(options: EdmIndexSaveAsOptions) {
  return async function saveEdmIndex(
    projectRoot: string,
    rendered: RenderedEdmSkuIndex,
  ): Promise<EdmSkuIndexExportResult> {
    const counts = {
      sku_count: rendered.sku_count,
      missing_image_count: rendered.missing_image_count,
    };
    let selection: EdmIndexSaveDialogResult;
    const expectedContent = Buffer.from(rendered.content, "utf8");
    try {
      selection = await options.showSaveDialog({
        title: "另存 EDM SKU 清单",
        defaultPath: options.defaultPath,
        properties: ["showOverwriteConfirmation"],
        filters: [{ name: "Markdown 文件", extensions: ["md"] }],
      });
    } catch {
      throw saveError("WRITE_FAILED", "无法打开清单另存对话框。", "EDM_INDEX_SAVE_DIALOG_FAILED");
    }
    if (selection.canceled || !selection.filePath) return { status: "cancelled", ...counts };

    const targetPath = path.resolve(selection.filePath);
    const targetName = path.basename(targetPath);
    if (!targetName || targetName === "." || targetName === "..") {
      throw saveError("WRITE_FAILED", "无法安全保存清单，请重新选择保存位置。", "EDM_INDEX_INVALID_TARGET");
    }

    let projectSnapshot: DirectorySnapshot;
    let parentSnapshot: DirectorySnapshot;
    try {
      projectSnapshot = await snapshotDirectory(projectRoot);
      parentSnapshot = await snapshotDirectory(path.dirname(targetPath));
    } catch {
      throw saveError("WRITE_FAILED", "无法安全确认所选保存位置，请选择其他位置。", "EDM_INDEX_UNSAFE_DIRECTORY");
    }

    const canonicalTarget = path.join(parentSnapshot.path, targetName);
    const targetIsInsideProject = isWithinDirectory(projectSnapshot.path, canonicalTarget);
    let existing: { matches: boolean } | null = null;
    try {
      existing = await readExistingRegularFile(canonicalTarget, expectedContent);
    } catch (error) {
      if (!isMissing(error)) {
        if (targetIsInsideProject) {
          throw saveError("EDM_INDEX_CONFLICT", "项目目录中的已有文件不会被覆盖，请另选一个新文件名。", "EDM_INDEX_PROJECT_FILE_EXISTS");
        }
        throw saveError("WRITE_FAILED", "无法安全检查已有文件，未写入清单。", "EDM_INDEX_TARGET_UNSAFE");
      }
    }
    if (existing) {
      if (targetIsInsideProject) {
        throw saveError("EDM_INDEX_CONFLICT", "项目目录中的已有文件不会被覆盖，请另选一个新文件名。", "EDM_INDEX_PROJECT_FILE_EXISTS");
      }
      await verifyDirectorySnapshot(projectSnapshot).catch(() => {
        throw saveError("WRITE_FAILED", "项目目录状态已变化，未写入清单。", "EDM_INDEX_PROJECT_CHANGED");
      });
      await verifyDirectorySnapshot(parentSnapshot).catch(() => {
        throw saveError("WRITE_FAILED", "保存目录状态已变化，未写入清单。", "EDM_INDEX_TARGET_DIRECTORY_CHANGED");
      });
      if (existing.matches) {
        return { status: "unchanged", file_name: targetName, ...counts };
      }
      throw saveError("WRITE_FAILED", "目标文件已存在且无法安全覆盖，请选择一个新文件名。", "EDM_INDEX_SAFE_REPLACE_UNAVAILABLE");
    }

    await verifyDirectorySnapshot(projectSnapshot).catch(() => {
      throw saveError("WRITE_FAILED", "项目目录状态已变化，未写入清单。", "EDM_INDEX_PROJECT_CHANGED");
    });
    await verifyDirectorySnapshot(parentSnapshot).catch(() => {
      throw saveError("WRITE_FAILED", "保存目录状态已变化，未写入清单。", "EDM_INDEX_TARGET_DIRECTORY_CHANGED");
    });

    const temporaryPath = path.join(parentSnapshot.path, `.siteindex-edm-${randomUUID()}.tmp`);
    let createdTarget = false;
    let temporaryIdentity: { dev: number; ino: number } | null = null;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await options.beforeTemporaryOpenForTest?.();
      temporaryHandle = await open(temporaryPath, "wx", 0o600);
      const openedStats = await temporaryHandle.stat();
      if (!openedStats.isFile() || openedStats.ino === 0) throw new Error("temporary-file-identity-unavailable");
      temporaryIdentity = { dev: openedStats.dev, ino: openedStats.ino };
      await verifyTemporaryLocation(parentSnapshot, temporaryPath, temporaryIdentity, temporaryHandle);
      await options.beforeTemporaryWriteForTest?.();
      // Open may have followed a replaced junction/symlink parent. Verify both the
      // opened file identity and its canonical path before writing any export bytes.
      await verifyTemporaryLocation(parentSnapshot, temporaryPath, temporaryIdentity, temporaryHandle);
      await temporaryHandle.writeFile(rendered.content, "utf8");
      await temporaryHandle.sync();
      await options.beforeTemporaryPublishForTest?.();
      const temporaryStats = await lstat(temporaryPath);
      if (
        hasReparsePoint(temporaryStats) ||
        !temporaryStats.isFile() ||
        !temporaryIdentity ||
        !sameIdentity(temporaryIdentity, temporaryStats)
      ) {
        throw new Error("temporary-file-identity-unavailable");
      }
      await verifyDirectorySnapshot(projectSnapshot);
      await verifyDirectorySnapshot(parentSnapshot);
      try {
        await (options.createHardLink ?? link)(temporaryPath, canonicalTarget);
        createdTarget = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const racedTarget = await readExistingRegularFile(canonicalTarget, expectedContent).catch(() => null);
        if (targetIsInsideProject) {
          throw saveError("EDM_INDEX_CONFLICT", "项目目录中的已有文件不会被覆盖，请另选一个新文件名。", "EDM_INDEX_PROJECT_FILE_EXISTS");
        }
        if (racedTarget?.matches) {
          return { status: "unchanged", file_name: targetName, ...counts };
        }
        throw saveError("WRITE_FAILED", "目标文件已存在且无法安全覆盖，请选择一个新文件名。", "EDM_INDEX_SAFE_REPLACE_UNAVAILABLE");
      }

      const targetStats = await lstat(canonicalTarget);
      if (
        hasReparsePoint(targetStats) ||
        !targetStats.isFile() ||
        !sameIdentity(temporaryStats, targetStats)
      ) {
        throw new Error("created-target-identity-unverified");
      }
      await verifyDirectorySnapshot(projectSnapshot);
      await verifyDirectorySnapshot(parentSnapshot);
      const temporaryNow = await lstat(temporaryPath);
      if (sameIdentity(temporaryStats, temporaryNow) && temporaryNow.isFile() && !hasReparsePoint(temporaryNow)) {
        await unlink(temporaryPath);
        temporaryIdentity = null;
      }
      await temporaryHandle.close().catch(() => undefined);
      temporaryHandle = null;
      return { status: "created", file_name: targetName, ...counts };
    } catch (error) {
      if (createdTarget) {
        throw saveError(
          "EDM_EXPORT_OUTCOME_UNKNOWN",
          "清单写入结果暂无法确认，可重新打开目标文件核对。",
          "EDM_INDEX_CREATED_TARGET_CONFIRMATION_FAILED",
        );
      }
      if (error && typeof error === "object" && "code" in error && error.code === "EDM_INDEX_CONFLICT") throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "WRITE_FAILED") throw error;
      throw saveError("WRITE_FAILED", "无法安全保存清单，未覆盖已有文件。", "EDM_INDEX_CREATE_FAILED");
    } finally {
      let cleanupFailed = false;
      if (temporaryIdentity && temporaryHandle && !createdTarget) {
        try {
          // The open handle still identifies our file if its directory was moved or replaced.
          // Empty it before any path-based cleanup so a moved directory cannot retain the export.
          if (options.truncateTemporaryForTest) await options.truncateTemporaryForTest(temporaryHandle);
          else await temporaryHandle.truncate(0);
          await temporaryHandle.sync();
        } catch {
          cleanupFailed = true;
        }
      }
      if (temporaryIdentity) {
        // Unlink by path only while the original parent identity is still present.
        // If it moved, that same path may now name an unrelated replacement directory.
        const parentIsOriginal = await verifyDirectorySnapshot(parentSnapshot).then(
          () => true,
          () => false,
        );
        if (parentIsOriginal) {
          const temporaryNow = await lstat(temporaryPath).catch(() => null);
          if (
            temporaryNow &&
            temporaryNow.isFile() &&
            !hasReparsePoint(temporaryNow) &&
            sameIdentity(temporaryIdentity, temporaryNow)
          ) {
            await unlink(temporaryPath).catch(() => undefined);
          }
        }
      }
      if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
      if (cleanupFailed) {
        throw saveError(
          "WRITE_FAILED",
          "无法安全清空临时清单，保存目录状态异常。",
          "EDM_INDEX_TEMPORARY_CLEANUP_FAILED",
        );
      }
    }
  };
}
