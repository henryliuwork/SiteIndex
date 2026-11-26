import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanupProfile, createProfile, exitNormally, isolatedEnvironment,
  launchInstalledApp, redirectWindowsAppData, waitForObserved } from "./acceptance/session.mjs";
import { redactEvidence, verifyInstallerDigest } from "./acceptance/report.mjs";
import { inspectWindowsProfileLayout } from "./e-windows-profile-isolation.mjs";

const projectId = "synthetic-v085-schedule-diagnostic";
const taskNames = ["daily", "validate", "weekly", "readme", "monthly"]
  .flatMap((job) => [`\\SiteIndex\\${projectId}-${job}`, `SiteIndex - ${projectId}-${job}`]);
const reportDir = path.resolve("siteindex-v085-schedule-diagnostic-results");
const installer = process.argv[2] && path.resolve(process.argv[2]);
const expectedSha = process.env.SITEINDEX_DIAGNOSTIC_EXE_SHA256;
const report = { source: process.env.SITEINDEX_DIAGNOSTIC_SOURCE_SHA ?? null,
  run: process.env.SITEINDEX_DIAGNOSTIC_BUILD_RUN ?? null, installerSha256: expectedSha ?? null,
  stage: "preflight", classification: "not_run", before: [], after: [],
  saved: false, verify: null, cleanup: {}, failure: null };
let profile;
let redirect;
let session;
let installed = false;
let tasksOwned = false;

function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 300_000, env });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} exited ${result.status ?? "unknown"}`);
  return result.stdout;
}

async function exists(file) { try { await access(file); return true; } catch { return false; } }

function taskState(name) {
  const result = spawnSync("schtasks.exe", ["/Query", "/TN", name, "/XML"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  const missing = result.status === 1
    && /cannot find|does not exist|not found|找不到|不存在/iu.test(`${result.stdout}\n${result.stderr}`);
  if (result.error || (result.status !== 0 && !missing)) {
    throw new Error(`Synthetic task query failed with exit ${result.status ?? "unknown"}`);
  }
  return { name, readable: result.status === 0, missing, exitCode: result.status };
}

function removeSyntheticTasks() {
  if (!tasksOwned) return;
  for (const name of taskNames.filter((name) => taskState(name).readable)) {
    run("schtasks.exe", ["/Delete", "/TN", name, "/F"]);
  }
  assert(taskNames.every((name) => taskState(name).missing), "Synthetic schedule tasks remained after cleanup");
}

try {
  assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
    && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
  "Diagnosis requires an isolated GitHub-hosted Windows runner");
  assert(installer && /^[0-9a-f]{64}$/iu.test(expectedSha ?? ""), "Pinned installer and SHA256 are required");
  report.installerSha256 = await verifyInstallerDigest(installer, expectedSha);
  profile = await createProfile(process.env.RUNNER_TEMP);
  assert(Object.values(await inspectWindowsProfileLayout(profile.layout))
    .every((check) => check.withinRoot && check.noReparse), "Isolated profile escaped runner root");
  report.before = taskNames.map(taskState);
  assert(report.before.every((item) => item.missing), "A synthetic task name already exists");
  tasksOwned = true;
  redirect = redirectWindowsAppData(profile);
  await mkdir(path.join(profile.layout.appDataRoot, "SiteIndex"), { recursive: true });
  await writeFile(path.join(profile.layout.appDataRoot, "SiteIndex", "settings.json"), `${JSON.stringify({
    device_id: "synthetic-v085-runner", device_name: "Synthetic runner",
    projects_root: profile.layout.projectRoot, close_to_tray: false,
  })}\n`);

  report.stage = "install";
  run(installer, ["/S", `/D=${profile.layout.installDir}`], isolatedEnvironment(profile));
  installed = true;
  const executable = path.join(profile.layout.installDir, "SiteIndex.exe");
  assert(await exists(executable), "Installed app executable missing");
  session = await launchInstalledApp({ executable, profile, port: 9585 });
  const page = session.page;
  const created = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), {
    url: "https://schedule.example.test", brand: { name: "Synthetic Schedule Project" }, markets: ["US"],
    projects_root: profile.layout.projectRoot, folder_name: projectId,
    workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
  });
  assert.equal(created.id, projectId);
  await page.evaluate((id) => window.siteindex.runner.claim(id), projectId);
  report.stage = "save";
  const saved = await page.evaluate(async (id) => {
    const current = await window.siteindex.schedule.get(id);
    const config = structuredClone(current.config);
    config.daily = { enabled: true, days: [2, 4], time: "17:44" };
    return window.siteindex.schedule.save(id, config);
  }, projectId);
  report.saved = saved.config.daily.enabled && saved.config.daily.time === "17:44";
  assert(report.saved, "Packaged schedule.save did not retain the synthetic daily setting");
  const configFile = JSON.parse(await readFile(path.join(profile.layout.projectRoot, projectId,
    "_site-index", "site.json"), "utf8"));
  report.fileSaved = configFile.schedule?.daily?.enabled === true && configFile.schedule.daily.time === "17:44";
  assert(report.fileSaved, "Synthetic schedule setting was not persisted to site.json");
  await waitForObserved(() => taskState(`\\SiteIndex\\${projectId}-daily`).readable,
    { timeoutMs: 60_000, label: "synthetic Windows task registration" });
  report.after = taskNames.map(taskState);
  report.stage = "verify";
  const verification = await page.evaluate((id) => window.siteindex.schedule.verify(id), projectId);
  report.verify = redactEvidence({ state: verification.state, message: verification.message ?? null,
    error_detail: verification.error_detail ?? null });
  report.classification = verification.state === "error" && verification.error_detail
    ? "error_detail_captured" : verification.state === "ok" ? "not_reproduced" : "undetermined";
} catch (error) {
  report.classification = "harness_error";
  report.failure = redactEvidence({ message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null });
} finally {
  if (session) {
    try { report.cleanup.normalExit = await exitNormally(session); }
    catch (error) { report.cleanup.normalExitError = redactEvidence(String(error)); }
  }
  try { removeSyntheticTasks(); report.cleanup.tasksAbsent = true; }
  catch (error) { report.cleanup.taskError = redactEvidence(String(error)); }
  if (installed && profile) {
    try {
      const uninstaller = path.join(profile.layout.installDir, "Uninstall SiteIndex.exe");
      if (await exists(uninstaller)) run(uninstaller, ["/S"], isolatedEnvironment(profile));
      await waitForObserved(async () => !await exists(path.join(profile.layout.installDir, "SiteIndex.exe")),
        { timeoutMs: 15_000, label: "NSIS uninstall" });
      report.cleanup.uninstalled = true;
    } catch (error) { report.cleanup.uninstallError = redactEvidence(String(error)); }
  }
  if (profile) {
    try { report.cleanup.profile = await cleanupProfile(profile, { redirect }); }
    catch (error) {
      report.cleanup.profile = { status: "harness_error", message: redactEvidence(String(error)) };
      report.classification = "harness_error";
    }
  }
  if (report.cleanup.taskError || report.cleanup.uninstallError || report.cleanup.normalExitError
    || report.cleanup.profile?.status === "harness_error") report.classification = "harness_error";
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "diagnostic.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (report.classification === "harness_error" || report.cleanup.taskError || report.cleanup.uninstallError
  || report.cleanup.normalExitError || report.cleanup.profile?.status === "harness_error") process.exitCode = 1;
