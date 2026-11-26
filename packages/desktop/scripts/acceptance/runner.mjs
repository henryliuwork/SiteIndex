import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReport, verifyInstallerDigest, assertNormalExit } from "./report.mjs";
import { verifyRemoteSources } from "./source-provenance.mjs";
import {
  createProfile, redirectWindowsAppData, cleanupProfile, launchInstalledApp, exitNormally,
  installWindowsNsis, uninstallWindowsNsis,
} from "./session.mjs";

const ASSERTION_PHASES = new Set(["baseline-ipc", "baseline-file", "candidate-ipc", "candidate-file",
  "baseline-exit", "baseline-reopen-ipc", "baseline-reopen-exit", "candidate-exit",
  "candidate-reopen-ipc", "candidate-reopen-exit"]);

export function parseItemRange(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("--items requires a range such as 1-83");
  const items = new Set();
  for (const segment of input.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(segment.trim());
    if (!match) throw new Error(`Invalid acceptance item range: ${segment}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last > 83 || first > last) throw new Error(`Acceptance item outside 1-83: ${segment}`);
    for (let id = first; id <= last; id++) {
      if (items.has(id)) throw new Error(`Duplicate acceptance item: ${id}`);
      items.add(id);
    }
  }
  return [...items].sort((a, b) => a - b);
}

/** The workflow verifies remote provenance; this layer requires immutable metadata and both local SHA matches. */
export function pinnedSource(source, label) {
  if (!source?.file || !source?.ref || !source?.artifact || !Number.isInteger(source?.runId) || source.runId <= 0
    || !Number.isInteger(source?.artifactId) || source.artifactId <= 0
    || !/^[a-f\d]{40}$/iu.test(source?.commit ?? "")
    || !/^[a-f\d]{64}$/iu.test(source?.sha256 ?? "")) {
    throw new Error(`${label} installer needs a file, ref, 40-character commit, run/artifact IDs and SHA256`);
  }
  return { file: path.resolve(source.file), ref: source.ref, commit: source.commit,
    runId: source.runId, artifactId: source.artifactId,
    artifact: source.artifact, sha256: source.sha256.toLowerCase(),
    kind: source.kind, workflowId: source.workflowId, event: source.event,
    archiveSha256: source.archiveSha256?.toLowerCase() };
}

export async function verifyPinnedInstallers(baseline, candidate, verify = verifyInstallerDigest) {
  const oldSource = pinnedSource(baseline, "Baseline");
  const newSource = pinnedSource(candidate, "Candidate");
  await verify(oldSource.file, oldSource.sha256);
  await verify(newSource.file, newSource.sha256);
  return { baseline: oldSource, candidate: newSource };
}

function reportSource(source) {
  return { ref: source.ref, commit: source.commit, run_id: source.runId,
    artifact_id: source.artifactId, artifact: source.artifact, sha256: source.sha256,
    kind: source.kind, workflow_id: source.workflowId, event: source.event,
    archive_sha256: source.archiveSha256 };
}

function requiredHandler(handlers, id) {
  const handler = handlers[id];
  if (!handler || ["baselineUi", "verifyBaselineIpc", "verifyBaselineFile",
    "candidateUi", "verifyCandidateIpc", "verifyCandidateFile"]
    .some((key) => typeof handler[key] !== "function")) {
    throw new Error(`Acceptance row ${id} has no complete handler`);
  }
  return handler;
}

/** Lifecycle only. Item adapters and the workflow are added in later PRs. */
export async function runAcceptance({ itemIds, baseline, candidate, handlers, outputDir, runner = "windows-hosted",
  osBuild = os.release(), dependencies = {} }) {
  const deps = { verifyPinnedInstallers, verifyRemoteSources,
    createProfile, redirectWindowsAppData, cleanupProfile,
    installWindowsNsis, uninstallWindowsNsis, launchInstalledApp, exitNormally, ...dependencies };
  if (!Array.isArray(itemIds) || !itemIds.length || new Set(itemIds).size !== itemIds.length
    || itemIds.some((id) => !Number.isInteger(id) || id < 1 || id > 83)) {
    throw new Error("Valid acceptance item IDs are required");
  }
  if (!outputDir) throw new Error("An isolated acceptance output directory is required");
  const sources = { baseline: pinnedSource(baseline, "Baseline"), candidate: pinnedSource(candidate, "Candidate") };
  await mkdir(outputDir, { recursive: true });
  const report = createReport({ baseline: reportSource(sources.baseline), candidate: reportSource(sources.candidate),
    runner, osBuild });
  const reportFile = path.join(outputDir, "report.json");
  let verified = false;
  try {
    await deps.verifyRemoteSources(sources.baseline, sources.candidate);
    await deps.verifyPinnedInstallers(sources.baseline, sources.candidate);
    verified = true;
    report.add({ id: "H9", phase: "source-verification", status: "passed",
      evidence: ["GitHub run/artifact provenance and both installer SHA256 digests matched"] });
  } catch (error) {
    await report.failure({ id: "H9", phase: "source-verification", error, kind: "harness_error", outputDir });
  }
  if (!verified) {
    for (const id of itemIds) report.add({ id, phase: "preflight", status: "not_run", evidence: ["Pinned installer verification failed"] });
    await report.save(reportFile);
    return report.report;
  }
  let cleanupFailed = false;
  let cleanupRetries = 0;
  const attempted = new Set();
  for (const id of itemIds) {
    attempted.add(id);
    let phase = "handler";
    let profile;
    let redirect;
    let session;
    let installed = false;
    let handler;
    const consoleMessages = [];
    const context = { id, noteIpc: (operation) => { context.lastIpc = operation; }, lastIpc: null };
    try {
      handler = requiredHandler(handlers, id);
      phase = "profile";
      profile = await deps.createProfile();
      redirect = deps.redirectWindowsAppData(profile);
      const executable = path.join(profile.layout.installDir, "SiteIndex.exe");
      phase = "baseline-install";
      deps.installWindowsNsis(sources.baseline.file, profile);
      installed = true;
      phase = "baseline-launch";
      session = await deps.launchInstalledApp({ executable, profile });
      session.page.on?.("console", (message) => consoleMessages.push(message.text()));
      phase = "baseline-ui";
      await handler.baselineUi({ ...context, page: session.page, profile });
      phase = "baseline-ipc";
      await handler.verifyBaselineIpc({ ...context, page: session.page, profile });
      phase = "baseline-exit";
      assertNormalExit(await deps.exitNormally(session));
      session = null;
      phase = "baseline-file";
      await handler.verifyBaselineFile({ ...context, profile });
      phase = "baseline-reopen";
      session = await deps.launchInstalledApp({ executable, profile });
      session.page.on?.("console", (message) => consoleMessages.push(message.text()));
      phase = "baseline-reopen-ipc";
      await handler.verifyBaselineIpc({ ...context, page: session.page, profile });
      phase = "baseline-reopen-exit";
      assertNormalExit(await deps.exitNormally(session));
      session = null;
      phase = "candidate-install";
      deps.installWindowsNsis(sources.candidate.file, profile);
      phase = "candidate-launch";
      session = await deps.launchInstalledApp({ executable, profile });
      session.page.on?.("console", (message) => consoleMessages.push(message.text()));
      phase = "candidate-ui";
      await handler.candidateUi({ ...context, page: session.page, profile });
      phase = "candidate-ipc";
      await handler.verifyCandidateIpc({ ...context, page: session.page, profile });
      phase = "candidate-exit";
      assertNormalExit(await deps.exitNormally(session));
      session = null;
      phase = "candidate-file";
      await handler.verifyCandidateFile({ ...context, profile });
      phase = "candidate-reopen";
      session = await deps.launchInstalledApp({ executable, profile });
      session.page.on?.("console", (message) => consoleMessages.push(message.text()));
      phase = "candidate-reopen-ipc";
      await handler.verifyCandidateIpc({ ...context, page: session.page, profile });
      phase = "candidate-reopen-exit";
      assertNormalExit(await deps.exitNormally(session));
      session = null;
      report.add({ id, phase: "upgrade-readback", status: "passed" });
    } catch (error) {
      const kind = error?.acceptanceStatus ?? (ASSERTION_PHASES.has(phase) ? "assertion_failed" : "harness_error");
      await report.failure({ id, phase, error, kind, page: session?.page,
        consoleMessages, lastIpc: context.lastIpc, outputDir });
    } finally {
      if (session) {
        try { assertNormalExit(await deps.exitNormally(session)); session = null; }
        catch (error) { await report.failure({ id, phase: "cleanup-exit", error, kind: "harness_error",
          page: session?.page, consoleMessages, lastIpc: context.lastIpc, outputDir }); cleanupFailed = true; }
      }
      if (installed && profile && !session && typeof handler?.cleanupSystem === "function") {
        let cleanupSession;
        try {
          cleanupSession = await deps.launchInstalledApp({
            executable: path.join(profile.layout.installDir, "SiteIndex.exe"), profile,
          });
          await handler.cleanupSystem({ ...context, page: cleanupSession.page, profile });
          assertNormalExit(await deps.exitNormally(cleanupSession));
          cleanupSession = null;
        } catch (error) {
          await report.failure({ id, phase: "cleanup-system", error,
            kind: error?.acceptanceStatus ?? "harness_error", page: cleanupSession?.page,
            consoleMessages, lastIpc: context.lastIpc, outputDir });
          cleanupFailed = true;
          if (cleanupSession) {
            try { assertNormalExit(await deps.exitNormally(cleanupSession)); }
            catch (exitError) { await report.failure({ id, phase: "cleanup-system-exit", error: exitError,
              kind: "harness_error", outputDir }); }
          }
        }
      }
      if (installed && !session) {
        try { await deps.uninstallWindowsNsis(profile); }
        catch (error) { await report.failure({ id, phase: "cleanup-uninstall", error, kind: "harness_error", outputDir }); cleanupFailed = true; }
      }
      if (profile) {
        try {
          const cleaned = await deps.cleanupProfile(profile, { redirect });
          cleanupRetries += cleaned.retries ?? 0;
          if (cleaned.status !== "passed") {
            report.add({ id, phase: "cleanup-profile", status: "harness_error", evidence: [cleaned.message ?? "Profile cleanup failed"] });
            cleanupFailed = true;
          }
        } catch (error) {
          await report.failure({ id, phase: "cleanup-profile", error, kind: "harness_error", outputDir });
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) break;
    }
  }
  for (const id of itemIds) if (!attempted.has(id)) {
    report.add({ id, phase: "preflight", status: "not_run", evidence: ["Earlier profile cleanup failed"] });
  }
  report.setCleanup({ status: cleanupFailed ? "harness_error" : "passed", retries: cleanupRetries });
  await report.save(reportFile);
  return report.report;
}
