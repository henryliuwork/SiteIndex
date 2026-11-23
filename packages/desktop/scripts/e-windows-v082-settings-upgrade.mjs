import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeW2SyntheticFixture } from "./e-windows-v040-synthetic-fixture.mjs";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectContainedPath, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const BASELINE_SHA256 = "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22";
const CDP_PORT = 9347;
const OUTPUT_DIRECTORY = path.resolve("siteindex-v082-upgrade-results");
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true"
  || process.env.SITEINDEX_RUNNER_ENVIRONMENT !== "github-hosted" || !process.env.RUNNER_TEMP) {
  throw new Error("upgrade acceptance requires a fresh GitHub-hosted Windows runner");
}
const ROOT = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-v082-upgrade-"));
const LAYOUT = ROOT ? createWindowsProfileLayout(ROOT) : null;
const SETTINGS_PATH = LAYOUT ? path.join(LAYOUT.appDataRoot, "SiteIndex", "settings.json") : "";
const INSTALL_EXE = LAYOUT ? path.join(LAYOUT.installDir, "SiteIndex.exe") : "";
const PROJECT_PATH = LAYOUT ? path.join(LAYOUT.projectRoot, "synthetic-upgrade-project") : "";
const report = {
  sourceCommit: null,
  baseline: { tag: "v0.8.0", sha256: null },
  candidate: { sha256: null, expectedAsarSha256: null, installedAsarSha256: null },
  settings: { fields: [], unchangedAfterInstaller: false, unchangedAfterRunJob: false, unchangedAfterRead: false },
  runJob: { exitCode: null, successfulViewsRun: false, lockAbsent: false },
  result: "pending",
};
let stage = "initialization";
let processHandle;
let browser;
let redirect;
let installed = false;

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8", windowsHide: true, timeout: 300_000, ...options,
  });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} failed with exit code ${result.status ?? "unknown"}`);
  return result;
}

function hasInstalledSiteIndex() {
  for (const root of [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]) {
    const result = spawnSync("reg.exe", ["query", root, "/s"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) continue;
    if (result.stdout.split(/(?=HKEY_)/u).some((entry) => /^\s*DisplayName\s+REG_\w+\s+SiteIndex(?:\s+\d+(?:\.\d+)*)?\s*$/imu.test(entry))) return true;
  }
  return false;
}

function environment() {
  const env = windowsProfileEnvironment(LAYOUT, process.env);
  env.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = ROOT;
  env.SITEINDEX_PROFILE_PATH_TRACE = "1";
  env.ELECTRON_RENDERER_URL = "";
  env.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
  return env;
}

async function contained(root, candidate) {
  const check = await inspectContainedPath(root, candidate);
  assert(check.withinRoot && check.noReparse, "path must remain in the isolated runner directory");
}

async function prepareProfile() {
  await contained(process.env.RUNNER_TEMP, ROOT);
  for (const directory of Object.values(LAYOUT)) {
    if (typeof directory === "string") await mkdir(directory, { recursive: true });
  }
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const checks = await inspectWindowsProfileLayout(LAYOUT);
  assert(Object.values(checks).every((check) => check.withinRoot && check.noReparse), "isolated profile contains a reparse path");
  redirect = createWindowsAppDataRedirect({
    appDataRoot: LAYOUT.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }),
  });
  redirect.redirect();
  const probe = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { env: environment() });
  assert.equal(probe.stdout.trim().toLowerCase(), LAYOUT.appDataRoot.toLowerCase(), "native AppData path escaped isolated profile");
}

async function makeProject() {
  const fixture = makeW2SyntheticFixture("https://fixture.synthetic.invalid");
  const index = path.join(PROJECT_PATH, "index");
  const rows = [
    ["catalog/skus.jsonl", fixture.skus.sort((a, b) => a.sku.localeCompare(b.sku))],
    ["catalog/product_details.jsonl", fixture.productDetails],
    ["inventory/latest.jsonl", fixture.latest.sort((a, b) => a.sku.localeCompare(b.sku))],
    ["views/sku_stock.jsonl", fixture.skuStock.sort((a, b) => a.sku.localeCompare(b.sku))],
    ["views/products.jsonl", fixture.products.sort((a, b) => a.handle.localeCompare(b.handle))],
    ["seo/pages.jsonl", fixture.seoPages],
    ["seo/issues.jsonl", fixture.seoIssues],
    ["seo/links.jsonl", fixture.seoLinks],
    ["content/blog_index.jsonl", fixture.blogs],
    ["content/keywords.jsonl", []],
    ["ledgers/edm_campaigns.jsonl", []],
    ["ledgers/outreach.jsonl", fixture.outreach],
    ["logs/runs.jsonl", []],
  ];
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, "site.json"), `${JSON.stringify(fixture.config, null, 2)}\n`);
  for (const [name, values] of rows) {
    const target = path.join(index, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, values.length ? `${values.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  }
  for (const month of ["2026-10", "2026-11"]) {
    const target = path.join(index, "inventory", "events", `${month}.jsonl`);
    const rowsForMonth = fixture.events.filter((event) => event.date.startsWith(month));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${rowsForMonth.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  const summary = fixture.dailySummaryRows.map((row) =>
    [row.date, row.category, row.total, row.in_stock, row.out_of_stock, row.preorder, row.unknown].join(","));
  await writeFile(path.join(index, "inventory", "daily_summary.csv"),
    `date,category,total,in_stock,out_of_stock,preorder,unknown\n${summary.join("\n")}\n`);
  await writeFile(path.join(index, "catalog", "categories.json"), `${JSON.stringify(fixture.categories, null, 2)}\n`);
  await writeFile(path.join(index, "ledgers", "sku_media.csv"), "sku,image_role,image_url,alt_text,source,width,height,updated_at\n");
  await writeFile(path.join(index, "ledgers", "sku_tags.csv"), "sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at\n");
}

async function install(installerPath) {
  await contained(ROOT, installerPath);
  run(installerPath, ["/S", `/D=${LAYOUT.installDir}`], { env: environment() });
  await contained(ROOT, INSTALL_EXE);
  assert(await exists(path.join(LAYOUT.installDir, "resources", "ui", "index.html")), "installed UI resource is missing");
  installed = true;
}

async function stopInstalledApp() {
  if (browser) { await browser.close().catch(() => undefined); browser = undefined; }
  if (processHandle) { processHandle.kill(); processHandle = undefined; }
  if (!INSTALL_EXE || !await exists(INSTALL_EXE)) return;
  const script = [
    "$expected = [System.IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE)",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'SiteIndex.exe' -and $_.ExecutablePath -ieq $expected } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: INSTALL_EXE }, timeout: 20_000 });
  await delay(500);
}

async function launch() {
  await contained(ROOT, INSTALL_EXE);
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  assert(!await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false), "CDP port is already in use");
  processHandle = spawn(INSTALL_EXE, [`--remote-debugging-port=${CDP_PORT}`, "--disable-gpu"], {
    cwd: ROOT, env: environment(), windowsHide: true, stdio: "ignore",
  });
  processHandle.on("error", () => undefined);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error("installed app exited before CDP started");
    if (await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false)) break;
    await delay(500);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
  let page;
  while (Date.now() < deadline + 30_000) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:") && candidate.url().includes("/ui/index.html"));
    if (page) break;
    await delay(300);
  }
  if (!page) {
    const targets = browser.contexts().flatMap((context) => context.pages()).map((target) =>
      target.url().includes("fallback.html") ? "fallback" : target.url() === "about:blank" ? "blank" : "other");
    throw new Error(`installed app did not load resources/ui/index.html; targets=${targets.join(",") || "none"}; processExit=${processHandle.exitCode}`);
  }
  await page.waitForFunction(() => Boolean(window.siteindex?.settings?.get), null, { timeout: 30_000 });
  return page;
}

function settingsPatch() {
  return {
    device_name: "Synthetic acceptance desktop",
    projects_root: LAYOUT.projectRoot,
    extra_projects: [],
    hidden_projects: [],
    close_to_tray: false,
    launch_at_login: true,
    cache_dir: path.join(ROOT, "cache"),
    browser: { channel: "chrome", executable_path: null },
    notify: { on_failure: false, on_success: true, oos_threshold: 7, dingtalk_webhook: null },
    skill_platforms: [{ id: "synthetic-agent", name: "Synthetic agent", dir: path.join(ROOT, "agent-skills"), detected: false }],
    conflict_patterns: ["synthetic-conflict-pattern"],
  };
}

function checkFields(actual, expected, deviceId) {
  for (const [key, value] of Object.entries(expected)) {
    if (key === "browser" || key === "notify") {
      for (const [field, expectedValue] of Object.entries(value)) {
        assert.deepEqual(actual[key]?.[field], expectedValue, `settings field ${key}.${field} changed during upgrade`);
      }
    } else {
      assert.deepEqual(actual[key], value, `settings field ${key} changed during upgrade`);
    }
  }
  assert.equal(actual.device_id, deviceId, "device_id changed during upgrade");
  return ["device_id", ...Object.entries(expected).flatMap(([key, value]) =>
    key === "browser" || key === "notify" ? Object.keys(value).map((field) => `${key}.${field}`) : [key])];
}

async function main() {
  assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
    && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted",
  "upgrade acceptance requires a fresh GitHub-hosted Windows runner");
  assert(ROOT && LAYOUT && process.env.RUNNER_TEMP, "isolated runner root is missing");
  assert(!hasInstalledSiteIndex(), "runner already has SiteIndex installed");
  const [oldInput, newInput] = process.argv.slice(2).map((value) => path.resolve(value));
  assert(oldInput && newInput && await exists(oldInput) && await exists(newInput), "both NSIS installers are required");
  report.sourceCommit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  stage = "installer provenance";
  assert.equal(await sha256(oldInput), BASELINE_SHA256, "v0.8.0 GitHub Release installer digest changed");
  report.baseline.sha256 = BASELINE_SHA256;
  report.candidate.sha256 = await sha256(newInput);
  const expectedAsar = path.resolve("release", "win-unpacked", "resources", "app.asar");
  assert(await exists(expectedAsar), "candidate production NSIS build did not retain win-unpacked/app.asar");
  report.candidate.expectedAsarSha256 = await sha256(expectedAsar);

  stage = "isolated profile";
  await prepareProfile();
  await makeProject();
  // The packaged first-run directory picker blocks window creation until a root exists.
  // Seed only the synthetic root; all other settings are saved through v0.8.0 IPC below.
  await writeFile(SETTINGS_PATH, `${JSON.stringify({
    device_id: "synthetic-v082-runner",
    device_name: "Synthetic runner",
    projects_root: LAYOUT.projectRoot,
    close_to_tray: false,
  })}\n`);
  const baselineInstaller = path.join(ROOT, "baseline-setup.exe");
  const candidateInstaller = path.join(ROOT, "candidate-setup.exe");
  await Promise.all([copyFile(oldInput, baselineInstaller), copyFile(newInput, candidateInstaller)]);
  await contained(ROOT, baselineInstaller);
  await contained(ROOT, candidateInstaller);

  stage = "v0.8.0 baseline install and save";
  await install(baselineInstaller);
  await stopInstalledApp();
  const oldAsarSha256 = await sha256(path.join(LAYOUT.installDir, "resources", "app.asar"));
  const oldPage = await launch();
  const baselineVersion = await oldPage.evaluate(() => window.siteindex.app.version());
  assert.equal(baselineVersion, "0.8.0", "baseline IPC app version is wrong");
  const initial = await oldPage.evaluate(() => window.siteindex.settings.get());
  const patch = settingsPatch();
  const saved = await oldPage.evaluate((values) => window.siteindex.settings.set(values), patch);
  const baselineRead = await oldPage.evaluate(() => window.siteindex.settings.get());
  report.settings.fields = checkFields(saved, patch, initial.device_id);
  checkFields(baselineRead, patch, initial.device_id);
  await stopInstalledApp();
  const baselineRaw = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  checkFields(baselineRaw, patch, initial.device_id);
  // Simulate a user-owned field introduced after the baseline build.
  baselineRaw.future_user_field = "synthetic-preserved";
  baselineRaw.browser.future_browser_field = "synthetic-preserved";
  baselineRaw.notify.future_notify_field = "synthetic-preserved";
  await writeFile(SETTINGS_PATH, `${JSON.stringify(baselineRaw, null, 4)}\n`);
  const originalSettingsBytes = await readFile(SETTINGS_PATH);
  await writeFile(path.join(PROJECT_PATH, "index", ".runner.json"), `${JSON.stringify({
    device_id: initial.device_id, device_name: patch.device_name, claimed_at: new Date().toISOString(),
  })}\n`);

  stage = "candidate NSIS overwrite";
  await install(candidateInstaller);
  await stopInstalledApp();
  report.candidate.installedAsarSha256 = await sha256(path.join(LAYOUT.installDir, "resources", "app.asar"));
  assert.notEqual(report.candidate.installedAsarSha256, oldAsarSha256, "candidate did not replace baseline app.asar");
  assert.equal(report.candidate.installedAsarSha256, report.candidate.expectedAsarSha256,
    "installed app.asar differs from the production NSIS candidate");
  report.settings.unchangedAfterInstaller = (await readFile(SETTINGS_PATH)).equals(originalSettingsBytes);
  assert(report.settings.unchangedAfterInstaller, "candidate installer changed settings.json bytes");

  stage = "candidate packaged --run-job";
  const job = spawnSync(INSTALL_EXE, ["--run-job", PROJECT_PATH, "views"], {
    cwd: ROOT, env: environment(), encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  report.runJob.exitCode = job.status;
  const runs = (await readFile(path.join(PROJECT_PATH, "index", "logs", "runs.jsonl"), "utf8"))
    .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  report.runJob.successfulViewsRun = runs.some((entry) => entry.job === "views" && entry.status === "ok");
  report.runJob.lockAbsent = !await exists(path.join(PROJECT_PATH, "index", ".lock"))
    && !await exists(path.join(PROJECT_PATH, "_site-index", ".lock"));
  assert(!job.error && job.status === 0 && report.runJob.successfulViewsRun && report.runJob.lockAbsent,
    "candidate packaged --run-job views did not complete cleanly");
  report.settings.unchangedAfterRunJob = (await readFile(SETTINGS_PATH)).equals(originalSettingsBytes);
  assert(report.settings.unchangedAfterRunJob, "candidate --run-job changed settings.json bytes");

  stage = "candidate installed IPC readback";
  const newPage = await launch();
  const newSettings = await newPage.evaluate(() => window.siteindex.settings.get());
  checkFields(newSettings, patch, initial.device_id);
  assert.equal(newSettings.future_user_field, "synthetic-preserved");
  assert.equal(newSettings.browser.future_browser_field, "synthetic-preserved");
  assert.equal(newSettings.notify.future_notify_field, "synthetic-preserved");
  await newPage.evaluate(() => window.siteindex.settings.set({}));
  report.settings.unchangedAfterRead = (await readFile(SETTINGS_PATH)).equals(originalSettingsBytes);
  assert(report.settings.unchangedAfterRead, "candidate settings.get/set({}) rewrote settings.json");
  report.result = "passed";
}

let failure;
try {
  await main();
} catch (error) {
  failure = { stage, category: error?.name ?? "Error",
    message: String(error?.message ?? error).replaceAll(ROOT, "<isolated>").replaceAll(process.cwd(), "<checkout>") };
  report.result = "failed";
  console.error(`v0.8.2 settings upgrade failed at ${stage}: ${failure.message}`);
} finally {
  try { await stopInstalledApp(); } catch { failure ??= { stage: "cleanup", category: "APP_STOP_FAILED" }; }
  if (installed && LAYOUT && await exists(path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe"))) {
    try {
      await contained(ROOT, path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe"));
      run(path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: environment() });
    } catch { failure ??= { stage: "cleanup", category: "UNINSTALL_FAILED" }; }
  }
  if (redirect?.hasChanges && !redirect.restored) {
    try {
      if (!redirect.restore()) failure ??= { stage: "cleanup", category: "APPDATA_RESTORE_FAILED" };
    } catch {
      failure ??= { stage: "cleanup", category: "APPDATA_RESTORE_FAILED" };
    }
  }
  if (ROOT && (!redirect || redirect.canRemoveProfileRoot)) {
    try {
      await contained(process.env.RUNNER_TEMP, ROOT);
      await rm(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      assert(!await exists(ROOT), "isolated profile remains after cleanup");
    } catch (error) {
      failure ??= { stage: "cleanup", category: "PROFILE_CLEANUP_FAILED",
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN" };
    }
  }
  if (failure) report.result = "failed";
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(path.join(OUTPUT_DIRECTORY, "summary.json"), `${JSON.stringify({ ...report, failure }, null, 2)}\n`);
  await writeFile(path.join(OUTPUT_DIRECTORY, "summary.md"), [
    "## v0.8.0 → v0.8.2 candidate settings upgrade",
    `- Result: ${report.result}`,
    `- Source commit: ${report.sourceCommit ?? "unavailable"}`,
    `- Baseline: ${report.baseline.tag}, GitHub Release EXE SHA256 ${report.baseline.sha256 ?? "unverified"}`,
    `- Candidate production NSIS EXE SHA256: ${report.candidate.sha256 ?? "unavailable"}`,
    `- Candidate app.asar matches installed copy: ${report.candidate.expectedAsarSha256 !== null && report.candidate.expectedAsarSha256 === report.candidate.installedAsarSha256}`,
    `- Settings fields checked: ${report.settings.fields.join(", ") || "none"}`,
    `- Byte-identical after installer / --run-job / IPC readback: ${report.settings.unchangedAfterInstaller} / ${report.settings.unchangedAfterRunJob} / ${report.settings.unchangedAfterRead}`,
    `- Packaged --run-job views: exit ${report.runJob.exitCode}, history success ${report.runJob.successfulViewsRun}, lock absent ${report.runJob.lockAbsent}`,
    `- Failure stage: ${failure?.stage ?? "none"}`,
    "- Data: GitHub-hosted isolated profile and synthetic-only project; no user installation or real site data.",
  ].join("\n") + "\n");
}
if (failure) process.exitCode = 1;
