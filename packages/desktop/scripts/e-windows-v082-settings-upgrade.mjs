import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeW2SyntheticFixture } from "./e-windows-v040-synthetic-fixture.mjs";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectContainedPath, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";
import { exerciseBaselineAppSettings, exerciseCandidateAppClears, exerciseCandidateAppReadback } from "./e-windows-v082-app-settings-ui.mjs";

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
const EXTRA_PROJECT_PATH = ROOT ? path.join(ROOT, "extra-project.example.test") : "";
const HIDDEN_PROJECT_PATH = LAYOUT ? path.join(LAYOUT.projectRoot, "hidden-project.example.test") : "";
const report = {
  sourceCommit: null,
  baseline: { tag: "v0.8.0", sha256: null },
  candidate: { version: null, sha256: null, expectedAsarSha256: null, installedAsarSha256: null },
  settings: { fields: [], uiRows: [], candidateRows: [], clearRows: [], vault: {},
    unchangedAfterInstaller: false, unchangedAfterRead: false,
    row71Evidence: { pr: 792, run: 45306799484, artifact: 14881925701,
      result: "fixed candidate packaged UI off/on/off and official baseline contrast passed" } },
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

async function vaultMetadata(origin) {
  const file = vaultFileFor(origin);
  await contained(LAYOUT.localAppDataRoot, file);
  try { return { exists: true, bytes: (await stat(file)).size, withinLocalAppData: true }; }
  catch (error) { if (error?.code === "ENOENT") return { exists: false, bytes: null, withinLocalAppData: true }; throw error; }
}
function vaultFileFor(origin) {
  return path.join(LAYOUT.vaultPath, `wordpress-${createHash("sha256").update(origin).digest("hex")}.vault.json`);
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
  fixture.config.edm = { image_host: { type: "wordpress" } };
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
  for (const [target, name, domain] of [
    [EXTRA_PROJECT_PATH, "Synthetic extra project", "extra.example.test"],
    [HIDDEN_PROJECT_PATH, "Synthetic hidden project", "hidden.example.test"],
  ]) {
    await cp(PROJECT_PATH, target, { recursive: true });
    const sitePath = path.join(target, "index", "site.json");
    const config = JSON.parse(await readFile(sitePath, "utf8"));
    config.domain = domain;
    config.base_url = `https://${domain}`;
    config.brand.name = name;
    delete config.edm;
    await writeFile(sitePath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

async function install(installerPath) {
  await contained(ROOT, installerPath);
  run(installerPath, ["/S", `/D=${LAYOUT.installDir}`], { env: environment() });
  await contained(ROOT, INSTALL_EXE);
  assert(await exists(path.join(LAYOUT.installDir, "resources", "ui", "index.html")), "installed UI resource is missing");
  installed = true;
}

async function stopInstalledApp() {
  if (!processHandle) return;
  const script = `
    Add-Type -Namespace SI -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
    $target = Get-Process -Id ${processHandle.pid} -ErrorAction SilentlyContinue
    if (-not $target -or $target.Path -ine $env:SITEINDEX_ACCEPTANCE_INSTALL_EXE -or $target.MainWindowHandle -eq 0) { exit 2 }
    if (-not [SI.Native]::PostMessage($target.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 3 }
  `;
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: INSTALL_EXE }, timeout: 20_000 });
  const deadline = Date.now() + 30_000;
  while (processHandle.exitCode === null && Date.now() < deadline) await delay(250);
  assert.equal(processHandle.exitCode, 0, "packaged app did not exit normally after WM_CLOSE");
  let remaining = 1;
  const childrenDeadline = Date.now() + 10_000;
  while (remaining && Date.now() < childrenDeadline) {
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $expected }).Count"],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: INSTALL_EXE }, timeout: 20_000 });
    remaining = Number(result.stdout.trim());
    if (remaining) await delay(250);
  }
  assert.equal(remaining, 0, "packaged app still has running processes after WM_CLOSE");
  if (browser) { await browser.close().catch(() => undefined); browser = undefined; }
  processHandle = undefined;
}

function cancelFirstRunPicker(processId) {
  const script = `
    Add-Type -Namespace SI -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
    $targetProcessId = ${processId}
    $deadline = (Get-Date).AddSeconds(35)
    while ((Get-Date) -lt $deadline) {
      $target = Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue
      if ($target -and $target.MainWindowHandle -ne 0 -and $target.MainWindowTitle -like '*选择项目根目录*') {
        if (-not [SI.Native]::PostMessage($target.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 2 }
        exit 0
      }
      Start-Sleep -Milliseconds 250
    }
    exit 3
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 45_000 });
  assert.equal(result.status, 0, "native first-run picker could not be safely cancelled");
}

async function launch(cancelPicker = false) {
  await contained(ROOT, INSTALL_EXE);
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  assert(!await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false), "CDP port is already in use");
  processHandle = spawn(INSTALL_EXE, [`--remote-debugging-port=${CDP_PORT}`, "--disable-gpu"], {
    cwd: ROOT, env: environment(), windowsHide: true, stdio: "ignore",
  });
  processHandle.on("error", () => undefined);
  if (cancelPicker) cancelFirstRunPicker(processHandle.pid);
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
    extra_projects: [EXTRA_PROJECT_PATH],
    hidden_projects: [HIDDEN_PROJECT_PATH],
    close_to_tray: false,
    cache_dir: path.join(ROOT, "cache"),
    browser: { channel: "custom", executable_path: path.join(ROOT, "fake-browser.example.test.exe") },
    notify: { on_failure: false, on_success: true, oos_threshold: 0.17, dingtalk_webhook: "https://example.test/hook" },
    skill_platforms: [],
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
  const candidateVersion = path.basename(newInput).match(/^SiteIndex-Setup-(\d+\.\d+\.\d+)\.exe$/u)?.[1];
  assert(candidateVersion === "0.8.2", "candidate installer must be SiteIndex-Setup-0.8.2.exe");
  report.candidate.version = candidateVersion;
  report.sourceCommit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  stage = "installer provenance";
  assert.equal(await sha256(oldInput), BASELINE_SHA256, "v0.8.0 GitHub Release installer digest changed");
  report.baseline.sha256 = BASELINE_SHA256;
  report.candidate.sha256 = await sha256(newInput);
  if (process.env.SITEINDEX_FIXED_ARTIFACT_MODE === "true") {
    assert.equal(report.candidate.sha256,
      "8dedcea2b0ef30e6d14ec006345a31bfd3b3fdb6f0c42cb876f6263f00ed12e6",
      "fixed candidate EXE SHA256 changed");
  } else {
    const expectedAsar = path.resolve("release", "win-unpacked", "resources", "app.asar");
    assert(await exists(expectedAsar), "candidate production NSIS build did not retain win-unpacked/app.asar");
    report.candidate.expectedAsarSha256 = await sha256(expectedAsar);
  }

  stage = "isolated profile";
  await prepareProfile();
  await makeProject();
  const baselineInstaller = path.join(ROOT, "baseline-setup.exe");
  const candidateInstaller = path.join(ROOT, "candidate-setup.exe");
  await Promise.all([copyFile(oldInput, baselineInstaller), copyFile(newInput, candidateInstaller)]);
  await contained(ROOT, baselineInstaller);
  await contained(ROOT, candidateInstaller);

  stage = "v0.8.0 baseline install and save";
  await install(baselineInstaller);
  await stopInstalledApp();
  const oldAsarSha256 = await sha256(path.join(LAYOUT.installDir, "resources", "app.asar"));
  const oldPage = await launch(true);
  const baselineVersion = await oldPage.evaluate(() => window.siteindex.app.version());
  assert.equal(baselineVersion, "0.8.0", "baseline IPC app version is wrong");
  const initial = await oldPage.evaluate(() => window.siteindex.settings.get());
  await oldPage.evaluate(() => { window.location.hash = "#/settings"; });
  const trayToggle = oldPage.getByRole("checkbox", { name: "关闭窗口时最小化到托盘" });
  await trayToggle.waitFor();
  if (await trayToggle.isChecked()) await trayToggle.click();
  await oldPage.waitForFunction(async () => (await window.siteindex.settings.get()).close_to_tray === false);
  await oldPage.getByText("正在保存软件设置…").waitFor({ state: "hidden", timeout: 12_000 });
  await stopInstalledApp();
  const target = settingsPatch();
  report.settings.uiRows = await exerciseBaselineAppSettings({
    launch, stop: stopInstalledApp, settingsPath: SETTINGS_PATH,
    values: { ...target,
      skillDirectory: path.join(ROOT, "agent-skills.example.test"),
      extraProject: EXTRA_PROJECT_PATH,
      hiddenProject: HIDDEN_PROJECT_PATH,
      wpOrigin: "https://fixture.synthetic.invalid" },
  });
  assert.equal(report.settings.uiRows.find((row) => row.id === 82)?.status, "passed",
    "application UI setting 82 vault status could not be verified on hosted runner");
  report.settings.vault.baseline = await vaultMetadata("https://fixture.synthetic.invalid");
  assert(report.settings.vault.baseline.exists && report.settings.vault.baseline.bytes > 0,
    "baseline WordPress vault missing after normal restart");
  const baselineVaultDigest = await sha256(vaultFileFor("https://fixture.synthetic.invalid"));
  const finalOldPage = await launch();
  const afterUi = await finalOldPage.evaluate(() => window.siteindex.settings.get());
  await finalOldPage.evaluate((patterns) => window.siteindex.settings.set({ conflict_patterns: patterns }), target.conflict_patterns);
  const patch = { ...target,
    skill_platforms: afterUi.skill_platforms,
    extra_projects: afterUi.extra_projects,
    hidden_projects: afterUi.hidden_projects,
  };
  const saved = await finalOldPage.evaluate(() => window.siteindex.settings.get());
  const baselineRead = await finalOldPage.evaluate(() => window.siteindex.settings.get());
  report.settings.fields = checkFields(saved, patch, initial.device_id);
  checkFields(baselineRead, patch, initial.device_id);
  await stopInstalledApp();
  const baselineRaw = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  checkFields(baselineRaw, patch, initial.device_id);
  report.settings.uiRows = report.settings.uiRows.map((row) => row.id === 81
    ? { id: 81, status: "passed", evidence: "baseline packaged IPC save + file readback" } : row);
  const originalSettingsBytes = await readFile(SETTINGS_PATH);

  stage = "candidate NSIS overwrite";
  await install(candidateInstaller);
  await stopInstalledApp();
  report.candidate.installedAsarSha256 = await sha256(path.join(LAYOUT.installDir, "resources", "app.asar"));
  assert.notEqual(report.candidate.installedAsarSha256, oldAsarSha256, "candidate did not replace baseline app.asar");
  if (report.candidate.expectedAsarSha256) assert.equal(report.candidate.installedAsarSha256,
    report.candidate.expectedAsarSha256, "installed app.asar differs from the production NSIS candidate");
  report.settings.unchangedAfterInstaller = (await readFile(SETTINGS_PATH)).equals(originalSettingsBytes);
  assert(report.settings.unchangedAfterInstaller, "candidate installer changed settings.json bytes");

  stage = "candidate installed IPC readback";
  const newPage = await launch();
  assert.equal(await newPage.evaluate(() => window.siteindex.app.version()), candidateVersion,
    "installed candidate IPC version differs from fixed EXE filename");
  const newSettings = await newPage.evaluate(() => window.siteindex.settings.get());
  checkFields(newSettings, patch, initial.device_id);
  const vaultRow = report.settings.uiRows.find((row) => row.id === 82);
  assert.equal(vaultRow?.status, "passed", "WordPress vault was not configured through baseline UI");
  assert.deepEqual(await newPage.evaluate(() => window.siteindexWindow.wordpressCredentials.status("https://fixture.synthetic.invalid")),
    { state: "configured" }, "WordPress vault status changed after upgrade");
  report.settings.vault.candidate = await vaultMetadata("https://fixture.synthetic.invalid");
  report.settings.vault.unchanged = report.settings.vault.candidate.exists
    && await sha256(vaultFileFor("https://fixture.synthetic.invalid")) === baselineVaultDigest;
  assert(report.settings.vault.unchanged && report.settings.vault.candidate.bytes === report.settings.vault.baseline.bytes,
    "candidate WordPress vault metadata changed after upgrade");
  report.settings.candidateRows = await exerciseCandidateAppReadback(newPage, SETTINGS_PATH, {
    ...target, skillDirectory: path.join(ROOT, "agent-skills.example.test"),
    extraProject: EXTRA_PROJECT_PATH, hiddenProject: HIDDEN_PROJECT_PATH,
  });
  await newPage.evaluate(() => { window.location.hash = "#/settings"; });
  await newPage.getByRole("heading", { name: "WordPress 图片托管凭据" }).waitFor();
  const credentialCard = newPage.getByRole("region", { name: "凭据：https://fixture.synthetic.invalid" });
  await credentialCard.getByText("本机凭据已保存").waitFor({ timeout: 12_000 });
  report.settings.candidateRows.push({ id: 82, status: "passed",
    evidence: "candidate credential UI + status + encrypted vault metadata" });
  assert(report.settings.candidateRows.length === 15
    && report.settings.candidateRows.every((row) => row.status === "passed"),
  "candidate application UI/IPC/file readback failed");
  for (const row of report.settings.uiRows) {
    if (row.status === "failed") throw new Error(`application UI setting ${row.id} failed packaged save/readback`);
  }
  report.settings.unchangedAfterRead = (await readFile(SETTINGS_PATH)).equals(originalSettingsBytes);
  assert(report.settings.unchangedAfterRead, "candidate settings.get rewrote settings.json");
  report.settings.clearRows = await exerciseCandidateAppClears(newPage, "https://fixture.synthetic.invalid");
  const beforeListClear = await newPage.evaluate(() => window.siteindex.settings.get());
  if (beforeListClear.extra_projects.length && beforeListClear.hidden_projects.length) {
    const cleared = await newPage.evaluate((revision) => window.siteindex.settings.set(
      { extra_projects: [], hidden_projects: [] },
      { revision, dirty_paths: ["extra_projects", "hidden_projects"], clear: ["extra_projects", "hidden_projects"] },
    ), beforeListClear.revision);
    assert.deepEqual(cleared.extra_projects, []);
    assert.deepEqual(cleared.hidden_projects, []);
    report.settings.clearRows.push({ id: 79, status: "passed", evidence: "candidate packaged explicit IPC clear only" });
    report.settings.clearRows.push({ id: 80, status: "passed", evidence: "candidate packaged explicit IPC clear only" });
  }
  const clearedFile = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  assert.equal(clearedFile.browser.executable_path, null, "browser UI clear did not reach settings.json");
  assert.equal(clearedFile.notify.dingtalk_webhook, null, "Webhook UI clear did not reach settings.json");
  if (report.settings.clearRows.some((row) => row.id === 79)) {
    assert.deepEqual(clearedFile.extra_projects, []);
    assert.deepEqual(clearedFile.hidden_projects, []);
  }
  for (const row of report.settings.clearRows) {
    if (row.status === "failed") throw new Error(`application UI setting ${row.id} failed candidate clear/readback`);
  }
  report.result = "passed";
}

let failure;
try {
  await main();
} catch (error) {
  if (error?.uiRows) report.settings.uiRows = error.uiRows;
  failure = { stage, category: error?.name ?? "Error",
    message: String(error?.message ?? error).replaceAll(ROOT, "<isolated>").replaceAll(process.cwd(), "<checkout>") };
  report.result = "failed";
  console.error(`v0.8.2 settings upgrade failed at ${stage}: ${failure.message}`);
} finally {
  try { await stopInstalledApp(); } catch { failure ??= { stage: "cleanup", category: "APP_STOP_FAILED" }; }
  if (!processHandle && installed && LAYOUT && await exists(path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe"))) {
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
  if (!processHandle && ROOT && (!redirect || redirect.canRemoveProfileRoot)) {
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
    `- Candidate app.asar changed from baseline: ${report.candidate.installedAsarSha256 !== null}; locally built asar match: ${report.candidate.expectedAsarSha256 ? report.candidate.expectedAsarSha256 === report.candidate.installedAsarSha256 : "not applicable (fixed artifact)"}`,
    `- Settings fields checked: ${report.settings.fields.join(", ") || "none"}`,
    `- #71 evidence: merged PR #${report.settings.row71Evidence.pr}, hosted Run ${report.settings.row71Evidence.run}, artifact ${report.settings.row71Evidence.artifact}; not repeated here`,
    `- Application rows: ${report.settings.uiRows.map((row) => `${row.id}:${row.status}`).join(", ") || "none"}`,
    `- Candidate readback rows: ${report.settings.candidateRows.map((row) => `${row.id}:${row.status}`).join(", ") || "none"}`,
    `- WordPress vault existed before/after upgrade: ${report.settings.vault.baseline?.exists ?? false} / ${report.settings.vault.candidate?.exists ?? false}`,
    `- WordPress encrypted vault unchanged after upgrade: ${report.settings.vault.unchanged ?? false}`,
    `- Candidate clear rows: ${report.settings.clearRows.map((row) => `${row.id}:${row.status}`).join(", ") || "none"}`,
    `- Byte-identical after installer / IPC readback: ${report.settings.unchangedAfterInstaller} / ${report.settings.unchangedAfterRead}`,
    `- Failure stage: ${failure?.stage ?? "none"}`,
    "- Data: GitHub-hosted isolated profile and synthetic-only project; no user installation or real site data.",
  ].join("\n") + "\n");
}
if (failure) process.exitCode = 1;
