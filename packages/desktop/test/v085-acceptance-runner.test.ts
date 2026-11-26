import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { parseItemRange, runAcceptance, verifyPinnedInstallers } from "../scripts/acceptance/runner.mjs";

const commit = "a".repeat(40);
const sha256 = "b".repeat(64);
const source = (file: string, ref: string) => ({ file, ref, commit, runId: 123,
  artifactId: 456, artifact: "siteindex-win", sha256 });
const handler = () => ({ baselineUi: async () => {}, verifyBaselineIpc: async () => {},
  verifyBaselineFile: async () => {}, candidateUi: async () => {},
  verifyCandidateIpc: async () => {}, verifyCandidateFile: async () => {} });

function fakeLifecycle(root: string) {
  let profileNumber = 0;
  const installWindowsNsis = vi.fn();
  const uninstallWindowsNsis = vi.fn(async () => {});
  const cleanupProfile = vi.fn(async () => ({ status: "passed", retries: 0 }));
  const exitNormally = vi.fn(async () => ({ method: "window.close", exitCode: 0, remainingProcesses: 0 }));
  return { installWindowsNsis, uninstallWindowsNsis, cleanupProfile, exitNormally,
    verifyPinnedInstallers: vi.fn(async () => {}),
    verifyRemoteSources: vi.fn(async () => {}),
    createProfile: vi.fn(async () => {
      const number = ++profileNumber;
      return { root: path.join(root, `profile-${number}`), layout: { installDir: path.join(root, `install-${number}`) } };
    }),
    redirectWindowsAppData: vi.fn(() => ({ restore: () => true })),
    launchInstalledApp: vi.fn(async () => ({ page: { on: () => {},
      screenshot: async ({ path: file }: { path?: string } = {}) => {
        const bytes = Buffer.from("synthetic-image");
        if (file) await writeFile(file, bytes);
        return bytes;
      } }, child: {}, browser: {} })),
  };
}

describe("v0.8.5 packaged acceptance lifecycle", () => {
  it("parses bounded item ranges and rejects duplicates", () => {
    assert.deepEqual(parseItemRange("3,1-2,83"), [1, 2, 3, 83]);
    assert.throws(() => parseItemRange("1,1"), /Duplicate/u);
    assert.throws(() => parseItemRange("84"), /outside 1-83/u);
    assert.throws(() => parseItemRange("1-x"), /Invalid/u);
  });

  it("checks both pinned installer SHA256 digests before installation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-pinned-pair-"));
    try {
      const oldFile = path.join(root, "baseline.exe");
      const newFile = path.join(root, "candidate.exe");
      await writeFile(oldFile, "synthetic baseline");
      await writeFile(newFile, "synthetic candidate");
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const oldSource = { ...source(oldFile, "v0.8.0"), sha256: digest("synthetic baseline") };
      const newSource = { ...source(newFile, "v0.8.5-rc.1"), sha256: digest("synthetic candidate") };
      await verifyPinnedInstallers(oldSource, newSource);
      await assert.rejects(() => verifyPinnedInstallers(oldSource, { ...newSource, sha256 }), /mismatch/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not install either package when pinned verification fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-bad-pin-"));
    try {
      const deps = fakeLifecycle(root);
      deps.verifyPinnedInstallers.mockImplementation(async () => { throw new Error("Synthetic SHA mismatch"); });
      const report = await runAcceptance({ itemIds: [1], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 1: handler() },
        outputDir: path.join(root, "out"), dependencies: deps });
      assert.equal(report.items.find((item) => item.id === "H9")?.status, "harness_error");
      assert.equal(report.items.find((item) => item.id === 1)?.status, "not_run");
      assert.equal(deps.installWindowsNsis.mock.calls.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stops before local installer checks if GitHub provenance fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-bad-provenance-"));
    try {
      const deps = fakeLifecycle(root);
      deps.verifyRemoteSources.mockImplementation(async () => { throw new Error("Synthetic run mismatch"); });
      const report = await runAcceptance({ itemIds: [1], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 1: handler() },
        outputDir: path.join(root, "out"), dependencies: deps });
      assert.equal(report.items.find((item) => item.id === "H9")?.status, "harness_error");
      assert.equal(deps.verifyPinnedInstallers.mock.calls.length, 0);
      assert.equal(deps.installWindowsNsis.mock.calls.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses a fresh profile per item and preserves baseline to candidate overwrite order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-acceptance-lifecycle-"));
    try {
      const deps = fakeLifecycle(root);
      const report = await runAcceptance({ itemIds: [1, 2], itemsArgument: "2,1", baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 1: handler(), 2: handler() },
        outputDir: path.join(root, "out"), dependencies: deps });
      assert.deepEqual(report.items.filter((item) => item.phase === "upgrade-readback").map((item) => item.id), [1, 2]);
      assert.equal(deps.createProfile.mock.calls.length, 2);
      assert.equal(deps.installWindowsNsis.mock.calls.length, 4);
      assert.equal(deps.exitNormally.mock.calls.length, 8);
      assert.equal(deps.uninstallWindowsNsis.mock.calls.length, 2);
      assert.equal(deps.cleanupProfile.mock.calls.length, 2);
      assert.notEqual(deps.installWindowsNsis.mock.calls[0][1], deps.installWindowsNsis.mock.calls[2][1]);
      assert.equal(deps.installWindowsNsis.mock.calls[0][0], path.resolve("baseline.exe"));
      assert.equal(deps.installWindowsNsis.mock.calls[1][0], path.resolve("candidate.exe"));
      assert.deepEqual(report.run.item_ids, [1, 2]);
      assert.equal(report.run.items_argument, "2,1");
      for (const id of [1, 2]) {
        const rows = report.items.filter((item) => item.id === id);
        assert.equal(rows.every((item) => item.profile_id === `synthetic-profile-${id}`), true);
        for (const phase of ["baseline-exit", "baseline-reopen-exit", "candidate-exit", "candidate-reopen-exit"]) {
          const exit = rows.find((item) => item.phase === phase);
          assert.equal(exit?.status, "passed");
          assert.deepEqual(exit?.evidence, [{ method: "window.close", exitCode: 0, remainingProcesses: 0 }]);
        }
      }
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "out", "report.json"), "utf8")),
        JSON.parse(JSON.stringify(report)));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies a readback mismatch without losing separate cleanup evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-acceptance-failure-"));
    try {
      const deps = fakeLifecycle(root);
      const bad = { ...handler(), verifyBaselineFile: async () => { throw new Error("Synthetic saved value missing"); } };
      const report = await runAcceptance({ itemIds: [7], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 7: bad },
        outputDir: path.join(root, "out"), dependencies: deps });
      assert.equal(report.items.find((item) => item.id === 7 && item.phase === "baseline-file")?.status,
        "assertion_failed");
      assert.equal(report.cleanup.status, "passed");
      assert.equal(deps.uninstallWindowsNsis.mock.calls.length, 1);
      assert.equal((await readFile(path.join(root, "out", "7.png"), "utf8")), "synthetic-image");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("attaches the candidate pre-exit screenshot when candidate file readback fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-candidate-file-screenshot-"));
    try {
      const deps = fakeLifecycle(root);
      const bad = { ...handler(), verifyCandidateFile: async () => { throw new Error("Synthetic candidate file mismatch"); } };
      const report = await runAcceptance({ itemIds: [8], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 8: bad },
        outputDir: path.join(root, "out"), dependencies: deps });
      assert.equal(report.items.find((item) => item.id === 8 && item.phase === "candidate-file")?.status,
        "assertion_failed");
      assert.equal((await readFile(path.join(root, "out", "8.png"), "utf8")), "synthetic-image");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps observed exit state when normal shutdown throws", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-exit-evidence-"));
    try {
      const deps = fakeLifecycle(root);
      let exits = 0;
      const exitNormally = async (session: any) => {
        if (++exits === 1) {
          session.child.exitCode = 3;
          session.executable = "synthetic.exe";
          session.inspect = () => 1;
          throw new Error("Synthetic normal exit failed");
        }
        return { method: "window.close", exitCode: 0, remainingProcesses: 0 };
      };
      const report = await runAcceptance({ itemIds: [9], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 9: handler() },
        outputDir: path.join(root, "out"), dependencies: { ...deps, exitNormally } });
      const failure = report.items.find((item) => item.id === 9 && item.phase === "baseline-exit");
      assert.equal(failure?.status, "assertion_failed");
      assert.deepEqual(failure?.evidence[0].exit_result,
        { method: "window.close", exitCode: 3, remainingProcesses: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("redacts runtime credential canaries from failure messages and saved reports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-credential-canary-"));
    const secret = "synthetic-runtime-password-canary";
    try {
      const deps = fakeLifecycle(root);
      const bad = { ...handler(), baselineUi: async () => { throw new Error(`Save failed: ${secret}`); } };
      const outputDir = path.join(root, "out");
      const report = await runAcceptance({ itemIds: [82], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"), handlers: { 82: bad },
        outputDir, secrets: [secret], dependencies: deps });
      assert.equal(JSON.stringify(report).includes(secret), false);
      assert.equal((await readFile(path.join(outputDir, "report.json"), "utf8")).includes(secret), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs system cleanup in a fresh installed session before NSIS uninstall", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-system-cleanup-"));
    try {
      const deps = fakeLifecycle(root);
      const cleanupSystem = vi.fn(async () => {});
      const report = await runAcceptance({ itemIds: [52], baseline: source("baseline.exe", "v0.8.0"),
        candidate: source("candidate.exe", "v0.8.5-rc.1"),
        handlers: { 52: { ...handler(), cleanupSystem } },
        outputDir: path.join(root, "out"), dependencies: deps });
      assert.equal(cleanupSystem.mock.calls.length, 1);
      assert.equal(deps.launchInstalledApp.mock.calls.length, 5);
      assert.equal(deps.exitNormally.mock.calls.length, 5);
      assert.equal(deps.uninstallWindowsNsis.mock.calls.length, 1);
      assert.equal(report.cleanup.status, "passed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
