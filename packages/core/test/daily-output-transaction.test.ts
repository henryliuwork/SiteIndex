import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pathsFor } from "@siteindex/shared";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  persistDailyOutputTransaction,
  recoverDailyOutputTransaction,
  type DailyOutputPaths,
  type DailyOutputWrite,
} from "../src/jobs/daily-output-transaction";

const roots: string[] = [];
const paths: DailyOutputPaths = pathsFor("legacy");
const eventTarget = `${paths.eventsDir}/2026-10.jsonl`;
const targets = [eventTarget, paths.inventoryLatest, paths.skus, paths.dailySummary] as const;
const beforeBytes = targets.map((_, index) => Buffer.from(`before-${index}\n`));
const afterBytes = targets.map((_, index) => Buffer.from(`after-${index}\n`));
const backupDirRelative = `${paths.jobLogsDir}/daily-output-transaction-backups`;
const manifestRelative = `${paths.jobLogsDir}/daily-output-transaction.json`;

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filePath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

async function newProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-output-transaction-"));
  roots.push(root);
  for (const [index, target] of targets.entries()) {
    const targetPath = filePath(root, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, beforeBytes[index]!);
  }
  return root;
}

async function createInterruptedTransaction(root: string, afterIndexes: readonly number[] = [0]): Promise<void> {
  const backupDirectory = filePath(root, backupDirRelative);
  await mkdir(backupDirectory, { recursive: true });
  const files = [];
  for (const [index, target] of targets.entries()) {
    const beforePath = filePath(root, `${backupDirRelative}/${index}.before`);
    const stagedPath = filePath(root, `${backupDirRelative}/${index}.after`);
    await writeFile(beforePath, beforeBytes[index]!);
    await writeFile(stagedPath, afterBytes[index]!);
    files.push({
      target,
      backup: `${backupDirRelative}/${index}.before`,
      staged: `${backupDirRelative}/${index}.after`,
      before_hash: hash(beforeBytes[index]!),
      after_hash: hash(afterBytes[index]!),
    });
    if (afterIndexes.includes(index)) await writeFile(filePath(root, target), afterBytes[index]!);
  }
  await writeFile(filePath(root, manifestRelative), `${JSON.stringify({ version: 2, files })}\n`);
}

async function exists(filePathValue: string): Promise<boolean> {
  try { await lstat(filePathValue); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daily output recovery transaction", () => {
  it("commits only the four fixed outputs and removes its recovery materials", async () => {
    const root = await newProject();
    const writes: DailyOutputWrite[] = targets.map((target, index) => ({
      target: filePath(root, target),
      writeTo: (destination) => writeFile(destination, afterBytes[index]!),
    }));

    await persistDailyOutputTransaction(root, paths, writes);

    for (const [index, target] of targets.entries()) {
      expect(await readFile(filePath(root, target))).toEqual(afterBytes[index]);
    }
    expect(await exists(filePath(root, manifestRelative))).toBe(false);
    expect(await exists(filePath(root, backupDirRelative))).toBe(false);
  });

  it("rolls back a valid interrupted transaction and remains idempotent", async () => {
    const root = await newProject();
    await createInterruptedTransaction(root, [0, 2]);

    await recoverDailyOutputTransaction(root, paths);
    await recoverDailyOutputTransaction(root, paths);

    for (const [index, target] of targets.entries()) {
      expect(await readFile(filePath(root, target))).toEqual(beforeBytes[index]);
    }
    expect(await exists(filePath(root, manifestRelative))).toBe(false);
    expect(await exists(filePath(root, backupDirRelative))).toBe(false);
  });

  it.each([
    ["empty file list", (manifest: Record<string, unknown>) => ({ ...manifest, files: [] })],
    ["duplicate target", (manifest: Record<string, unknown>) => {
      const files = [...manifest.files as Record<string, unknown>[]];
      files[1] = { ...files[1], target: targets[0] };
      return { ...manifest, files };
    }],
    ["target path outside the allowlist", (manifest: Record<string, unknown>) => {
      const files = [...manifest.files as Record<string, unknown>[]];
      files[0] = { ...files[0], target: "README.md" };
      return { ...manifest, files };
    }],
    ["backup path outside the transaction directory", (manifest: Record<string, unknown>) => {
      const files = [...manifest.files as Record<string, unknown>[]];
      files[0] = { ...files[0], backup: "README.md" };
      return { ...manifest, files };
    }],
  ])("rejects an unsafe manifest (%s) before changing any target", async (_label, mutate) => {
    const root = await newProject();
    await createInterruptedTransaction(root, [0]);
    const manifestPath = filePath(root, manifestRelative);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify(mutate(manifest))}\n`);

    await expect(recoverDailyOutputTransaction(root, paths)).rejects.toThrow("恢复已停止");

    expect(await readFile(filePath(root, targets[0]!))).toEqual(afterBytes[0]);
    expect(await exists(manifestPath)).toBe(true);
    expect(await exists(filePath(root, `${backupDirRelative}/0.before`))).toBe(true);
  });

  it("validates every backup before rollback when a later backup is missing", async () => {
    const root = await newProject();
    await createInterruptedTransaction(root, [0]);
    await rm(filePath(root, `${backupDirRelative}/3.before`));

    await expect(recoverDailyOutputTransaction(root, paths)).rejects.toThrow("备份不完整");

    expect(await readFile(filePath(root, targets[0]!))).toEqual(afterBytes[0]);
    expect(await exists(filePath(root, manifestRelative))).toBe(true);
    expect(await exists(filePath(root, `${backupDirRelative}/0.before`))).toBe(true);
  });

  it.each(["before backup hash", "after staging hash"])("validates the %s before rollback", async (artifact) => {
    const root = await newProject();
    await createInterruptedTransaction(root, [0]);
    const suffix = artifact === "before backup hash" ? "0.before" : "0.after";
    await writeFile(filePath(root, `${backupDirRelative}/${suffix}`), "tampered synthetic bytes\n");

    await expect(recoverDailyOutputTransaction(root, paths)).rejects.toThrow("校验失败");

    expect(await readFile(filePath(root, targets[0]!))).toEqual(afterBytes[0]);
    expect(await exists(filePath(root, manifestRelative))).toBe(true);
    expect(await exists(filePath(root, `${backupDirRelative}/0.after`))).toBe(true);
  });

  it("preserves an external edit and all recovery materials instead of overwriting it", async () => {
    const root = await newProject();
    await createInterruptedTransaction(root, [0]);
    const external = Buffer.from("external user edit\n");
    await writeFile(filePath(root, targets[1]!), external);

    await expect(recoverDailyOutputTransaction(root, paths)).rejects.toThrow("被其他进程修改");

    expect(await readFile(filePath(root, targets[0]!))).toEqual(afterBytes[0]);
    expect(await readFile(filePath(root, targets[1]!))).toEqual(external);
    expect(await exists(filePath(root, manifestRelative))).toBe(true);
    expect(await exists(filePath(root, `${backupDirRelative}/0.before`))).toBe(true);
  });
});
