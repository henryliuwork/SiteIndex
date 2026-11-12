import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanMediaCanaryTree } from "../scripts/media-production-canary-scan.mjs";

const roots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-media-scan-test-"));
  roots.push(root);
  const files = [
    "local-app-data/SiteIndex/LocalCredentials/wordpress-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.vault.json",
    "projects/synthetic/index/ledgers/sku_media.csv",
    "projects/synthetic/index/logs/runs.jsonl",
    "projects/synthetic/index/logs/jobs/synthetic-run.media.json",
  ];
  for (const relative of files) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "synthetic content", "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged media credential canary scan", () => {
  it("requires every critical media file class to be read and reports counts only", async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, "user-data", "Cache"), { recursive: true });
    await writeFile(path.join(root, "user-data", "Cache", "locked-cache.bin"), "ignored synthetic cache", "utf8");

    const summary = await scanMediaCanaryTree(root, ["synthetic credential canary"]);

    expect(summary.complete).toBe(true);
    expect(summary.matches).toBe(0);
    expect(summary.criticalFilesRead).toEqual({ credentialVault: 1, mediaLedger: 1, runs: 1, mediaCheckpoint: 1 });
    expect(summary.chromiumCachePathsSkipped).toBe(1);
    expect(summary.chromiumCacheReadErrors).toBe(0);
    expect(summary.criticalReadErrors).toBe(0);
    expect(summary.otherReadErrors).toBe(0);
  });

  it.each([
    [
      "credential vault",
      "local-app-data/SiteIndex/LocalCredentials/wordpress-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.vault.json",
    ],
    ["media ledger", "projects/synthetic/index/ledgers/sku_media.csv"],
    ["runs", "projects/synthetic/index/logs/runs.jsonl"],
    ["checkpoint", "projects/synthetic/index/logs/jobs/synthetic-run.media.json"],
  ])("fails closed when the critical %s cannot be read", async (_label, relativePath) => {
    const root = await createFixtureRoot();
    const normalizedTarget = path.resolve(root, relativePath);
    const summary = await scanMediaCanaryTree(root, ["synthetic credential canary"], {
      readFile: async (filePath: string) => {
        if (path.resolve(filePath) === normalizedTarget) throw new Error("synthetic-unreadable-critical-file");
        return readFile(filePath);
      },
    });

    expect(summary.complete).toBe(false);
    expect(summary.criticalReadErrors).toBe(1);
    expect(summary.missingCriticalKinds).toHaveLength(1);
  });
});
