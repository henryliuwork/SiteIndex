import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAcceptance } from "./runner.mjs";

const sha256 = "a".repeat(64);
const commit = "b".repeat(40);
const source = (file) => ({ file, ref: "synthetic", commit, runId: 1, artifactId: 2,
  artifact: "synthetic", sha256, kind: "run-artifact", workflowId: 3,
  event: "workflow_dispatch", archiveSha256: sha256 });
const handler = () => ({ baselineUi: async () => {}, verifyBaselineIpc: async () => {},
  verifyBaselineFile: async () => {}, candidateUi: async () => {},
  verifyCandidateIpc: async () => {}, verifyCandidateFile: async () => {} });

function fakeDependencies(root, exitNormally) {
  return { verifyPinnedInstallers: async () => {}, verifyRemoteSources: async () => {},
    createProfile: async () => ({ root: path.join(root, "profile"),
      layout: { installDir: path.join(root, "install") } }),
    redirectWindowsAppData: () => ({ restore: () => true }),
    installWindowsNsis: () => {}, uninstallWindowsNsis: async () => {},
    launchInstalledApp: async () => ({ page: { on: () => {}, screenshot: async ({ path: file } = {}) => {
      const bytes = Buffer.from("synthetic-pre-exit-image");
      if (file) await writeFile(file, bytes);
      return bytes;
    } }, child: {} }),
    exitNormally, cleanupProfile: async () => ({ status: "passed", retries: 0 }) };
}

export async function negativeSelfTest() {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v085-negative-"));
  const normal = async () => ({ method: "window.close", exitCode: 0, remainingProcesses: 0 });
  try {
    const missingFile = await runAcceptance({ itemIds: [1], baseline: source("baseline.exe"),
      candidate: source("candidate.exe"),
      handlers: { 1: { ...handler(), verifyBaselineFile: async () => {
        throw new Error("Synthetic UI reported saved, but file readback disagreed");
      } } },
      outputDir: path.join(root, "missing-file"), dependencies: fakeDependencies(root, normal) });
    assert.equal(missingFile.items.find((item) => item.id === 1)?.status, "assertion_failed",
      "Missing persistence was not rejected");
    assert.equal((await readFile(path.join(root, "missing-file", "1.png"), "utf8")), "synthetic-pre-exit-image");
    const forced = async () => ({ method: "kill", exitCode: 1, remainingProcesses: 0 });
    const killed = await runAcceptance({ itemIds: [2], baseline: source("baseline.exe"),
      candidate: source("candidate.exe"), handlers: { 2: handler() },
      outputDir: path.join(root, "forced-exit"), dependencies: fakeDependencies(root, forced) });
    const result = killed.items.find((item) => item.id === 2 && item.phase === "baseline-exit");
    assert.equal(result?.status, "assertion_failed", "Forced termination was not rejected");
    assert.match(result.evidence[0].message, /H1 violation/u);
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await negativeSelfTest();
  process.stdout.write("Both synthetic negative acceptance cases were rejected.\n");
}
