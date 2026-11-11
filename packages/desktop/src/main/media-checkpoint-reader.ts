import { lstat, open } from "node:fs/promises";

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface GuardedDirectory {
  path: string;
  identity: FileIdentity;
}

export interface StableBoundedReadTestHooks {
  /** Replace a checked path before open to exercise the path replacement race. */
  afterPathCheck?(): Promise<void>;
  /** Grow the opened file after the initial descriptor stat to exercise bounded reads. */
  afterHandleStat?(): Promise<void>;
}

function identityOf(stat: { dev: bigint; ino: bigint }): FileIdentity {
  if (stat.ino === 0n) throw new Error("File identity cannot be verified.");
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/**
 * Reads one bounded regular file through a single open handle. Path identities are checked before and
 * after the read; the bytes are capped independently of the initial stat size so growth cannot cause
 * an unbounded read. A substituted link/junction to a different file fails closed on descriptor identity.
 */
export async function readStableBoundedFile(
  filePath: string,
  maximumBytes: number,
  guardedDirectoryPaths: readonly string[] = [],
  hooks: StableBoundedReadTestHooks = {},
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid bounded-read limit.");

  const guardedDirectories: GuardedDirectory[] = [];
  for (const directoryPath of guardedDirectoryPaths) {
    const stat = await lstat(directoryPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Checkpoint directory identity cannot be verified.");
    guardedDirectories.push({ path: directoryPath, identity: identityOf(stat) });
  }

  const pathStat = await lstat(filePath, { bigint: true });
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.size > BigInt(maximumBytes)
  ) throw new Error("Checkpoint file is not a bounded regular file.");
  const initialIdentity = identityOf(pathStat);
  await hooks.afterPathCheck?.();

  const handle = await open(filePath, "r");
  try {
    const initialHandleStat = await handle.stat({ bigint: true });
    if (
      !initialHandleStat.isFile() ||
      !sameIdentity(initialIdentity, identityOf(initialHandleStat)) ||
      initialHandleStat.size > BigInt(maximumBytes) ||
      !sameSnapshot(pathStat, initialHandleStat)
    ) throw new Error("Checkpoint file changed before it was opened.");

    await hooks.afterHandleStat?.();

    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maximumBytes) throw new Error("Checkpoint file exceeds the bounded-read limit.");

    const finalHandleStat = await handle.stat({ bigint: true });
    if (!sameSnapshot(initialHandleStat, finalHandleStat) || finalHandleStat.size > BigInt(maximumBytes)) {
      throw new Error("Checkpoint file changed while it was read.");
    }

    for (const guarded of guardedDirectories) {
      const finalDirectoryStat = await lstat(guarded.path, { bigint: true });
      if (
        !finalDirectoryStat.isDirectory() ||
        finalDirectoryStat.isSymbolicLink() ||
        !sameIdentity(guarded.identity, identityOf(finalDirectoryStat))
      ) throw new Error("Checkpoint directory changed while it was read.");
    }

    const finalPathStat = await lstat(filePath, { bigint: true });
    if (
      !finalPathStat.isFile() ||
      finalPathStat.isSymbolicLink() ||
      !sameIdentity(identityOf(finalHandleStat), identityOf(finalPathStat))
    ) throw new Error("Checkpoint path changed while it was read.");

    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
