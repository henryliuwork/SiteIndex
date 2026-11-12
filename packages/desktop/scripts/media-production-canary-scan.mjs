import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const CRITICAL_KINDS = ["credentialVault", "mediaLedger", "runs", "mediaCheckpoint"];
const CHROMIUM_CACHE_NAMES = new Set([
  "cache",
  "code cache",
  "gpuCache".toLowerCase(),
  "dawncache",
  "grshadercache",
  "shadercache",
]);

function normalizedRelativePath(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function criticalKind(relativePath) {
  if (/^local-app-data\/SiteIndex\/LocalCredentials\/wordpress-[a-f0-9]{64}\.vault\.json$/iu.test(relativePath)) {
    return "credentialVault";
  }
  if (/^projects\/[^/]+\/index\/ledgers\/sku_media\.csv$/iu.test(relativePath)) return "mediaLedger";
  if (/^projects\/[^/]+\/index\/logs\/runs\.jsonl$/iu.test(relativePath)) return "runs";
  if (/^projects\/[^/]+\/index\/logs\/jobs\/[^/]+\.media\.json$/iu.test(relativePath)) return "mediaCheckpoint";
  return null;
}

function isChromiumCache(relativePath) {
  return relativePath.split("/").some((segment) => CHROMIUM_CACHE_NAMES.has(segment.toLowerCase()));
}

export async function scanMediaCanaryTree(root, canaries, io = {}) {
  const read = io.readFile ?? readFile;
  const readDirectory = io.readdir ?? readdir;
  const getStat = io.lstat ?? lstat;
  const resolvedRoot = path.resolve(root);
  const summary = {
    complete: false,
    filesScanned: 0,
    matches: 0,
    criticalFilesRead: Object.fromEntries(CRITICAL_KINDS.map((kind) => [kind, 0])),
    missingCriticalKinds: [],
    criticalReadErrors: 0,
    otherReadErrors: 0,
    chromiumCachePathsSkipped: 0,
    chromiumCacheReadErrors: 0,
  };

  async function visit(directory) {
    let entries;
    try {
      entries = await readDirectory(directory, { withFileTypes: true });
    } catch {
      if (isChromiumCache(normalizedRelativePath(resolvedRoot, directory))) {
        summary.chromiumCacheReadErrors += 1;
      } else {
        summary.otherReadErrors += 1;
      }
      return;
    }

    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relativePath = normalizedRelativePath(resolvedRoot, target);
      if (entry.isSymbolicLink()) {
        if (isChromiumCache(relativePath)) summary.chromiumCachePathsSkipped += 1;
        else summary.otherReadErrors += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (CHROMIUM_CACHE_NAMES.has(entry.name.toLowerCase())) {
          summary.chromiumCachePathsSkipped += 1;
          continue;
        }
        await visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isChromiumCache(relativePath)) {
        summary.chromiumCachePathsSkipped += 1;
        continue;
      }

      const kind = criticalKind(relativePath);
      try {
        const fileStat = await getStat(target);
        if (fileStat.size > MAX_SCAN_BYTES) throw new Error("scan-file-too-large");
        const bytes = await read(target);
        summary.filesScanned += 1;
        if (kind) summary.criticalFilesRead[kind] += 1;
        for (const canary of canaries) {
          if (bytes.includes(Buffer.from(canary))) summary.matches += 1;
        }
      } catch {
        if (kind) summary.criticalReadErrors += 1;
        else summary.otherReadErrors += 1;
      }
    }
  }

  await visit(resolvedRoot);
  summary.missingCriticalKinds = CRITICAL_KINDS.filter((kind) => summary.criticalFilesRead[kind] === 0);
  summary.complete =
    summary.missingCriticalKinds.length === 0 && summary.criticalReadErrors === 0 && summary.otherReadErrors === 0;
  return summary;
}
