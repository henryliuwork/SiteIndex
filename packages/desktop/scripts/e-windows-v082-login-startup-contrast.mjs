import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const PACKAGES = [
  { version: "0.7.6", sha256: "303d5fd725bb6f6f1e310b86d2bfe747b6b5f560548e87bae77ad98de6388514" },
  { version: "0.8.0", sha256: "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22" },
];
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"Version contrast requires a fresh GitHub-hosted Windows runner");
const installers = process.argv.slice(2).map((item) => path.resolve(item));
assert(installers.length === 2, "Two official NSIS installers are required");
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-790-"));
const reportDir = path.resolve("siteindex-v082-login-startup-results");
const report = { sourceCommit: null, versions: [], result: "pending", failure: null };
let current = null;

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} exit ${result.status ?? "unknown"}`);
  return result;
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
function env(layout) {
  const output = windowsProfileEnvironment(layout, process.env);
  output.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = layout.root;
  output.ELECTRON_RENDERER_URL = "";
  output.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete output[key];
  return output;
}
function sanitize(value, layout) {
  return String(value ?? "").replaceAll(layout.root, "<isolated>")
    .replaceAll(process.cwd(), "<checkout>").replaceAll(/https?:\/\/[^\s"']+/gu, "<url>").slice(0, 900);
}
function runEntries(exe) {
  const result = spawnSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.match(/^\s*(\S+)\s+REG_(\w+)\s+(.+)\s*$/u))
    .filter(Boolean).map((match) => ({ name: match[1], type: match[2], value: match[3].trim() }))
    .filter((entry) => /siteindex/iu.test(entry.name) || entry.value.toLowerCase().includes(exe.toLowerCase()));
}
function publicEntries(entries, layout) {
  return entries.map((entry) => ({ name: entry.name, type: entry.type,
    command: sanitize(entry.value, layout) }));
}
async function stopApp(state) {
  if (state.browser) { await state.browser.close().catch(() => undefined); state.browser = null; }
  if (state.process) { state.process.kill(); state.process = null; }
  if (!await exists(state.exe)) return;
  const script = [
    "$expected = [System.IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE)",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'SiteIndex.exe' -and $_.ExecutablePath -ieq $expected } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...env(state.layout), SITEINDEX_ACCEPTANCE_INSTALL_EXE: state.exe }, timeout: 20_000 });
  await delay(500);
}

function cancelFirstRunPicker(processId) {
  // Close only the native folder picker owned by this packaged process; never seed settings.json.
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
  if (result.status !== 0) throw new Error(`Native first-run folder picker could not be safely cancelled (${result.status ?? "unknown"})`);
}

async function launch(state) {
  const port = state.port;
  const endpoint = `http://127.0.0.1:${port}`;
  assert(!await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false), "CDP port already in use");
  state.process = spawn(state.exe, [`--remote-debugging-port=${port}`, "--disable-gpu"], {
    cwd: state.layout.root, env: env(state.layout), windowsHide: true, stdio: "ignore",
  });
  state.process.on("error", () => undefined);
  // With no project root, the app blocks at the native picker before creating its window.
  cancelFirstRunPicker(state.process.pid);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (state.process.exitCode !== null) throw new Error("Packaged app exited before CDP startup");
    if (await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await delay(300);
  }
  state.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  let page;
  while (Date.now() < deadline + 30_000) {
    page = state.browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (page) break;
    await delay(300);
  }
  assert(page, "Packaged UI did not open after native picker cancellation");
  await page.waitForFunction(() => Boolean(window.siteindex?.settings?.get), null, { timeout: 20_000 });
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await page.locator("#si-device-name").waitFor();
  return page;
}

async function toggle(state, enabled) {
  const page = await launch(state);
  const before = await page.evaluate(async () => ({
    settings: await window.siteindex.settings.get(), schedule: await window.siteindex.schedule.status(),
  }));
  assert.equal(before.settings.projects_root, "", "Test must retain an empty project root");
  assert.equal(before.settings.extra_projects.length, 0, "Test must have no projects");
  const checkbox = page.getByRole("checkbox", { name: "开机时启动 SiteIndex" });
  const ui = { beforeChecked: await checkbox.isChecked(), disabled: await checkbox.isDisabled(),
    scheduleMode: before.schedule.mode, hasProjects: false, actionError: null, toast: [] };
  try {
    assert.equal(ui.beforeChecked, !enabled, "Checkbox does not have the expected initial state");
    await checkbox.click({ timeout: 10_000 });
    await page.waitForFunction(async (expected) =>
      (await window.siteindex.settings.get()).launch_at_login === expected, enabled, { timeout: 10_000 });
  } catch (error) { ui.actionError = sanitize(error?.message ?? error, state.layout); }
  await delay(1000);
  ui.afterChecked = await checkbox.isChecked().catch(() => null);
  ui.toast = (await page.locator(".si-toast-region .si-toast").allTextContents())
    .map((message) => sanitize(message, state.layout));
  const afterIpc = await page.evaluate(() => window.siteindex.settings.get())
    .then((settings) => ({ value: settings.launch_at_login, error: null }))
    .catch((error) => ({ value: null, error: sanitize(error?.message ?? error, state.layout) }));
  await stopApp(state);
  const file = JSON.parse(await readFile(state.settingsPath, "utf8"));
  return { ui, ipc: afterIpc, fileValue: file.launch_at_login,
    registry: publicEntries(runEntries(state.exe), state.layout) };
}

async function ipcDiagnostic(state) {
  const page = await launch(state);
  const result = await page.evaluate(async () => {
    try { const saved = await window.siteindex.settings.set({ launch_at_login: true });
      return { value: saved.launch_at_login, error: null }; }
    catch (error) { return { value: null, error: String(error?.message ?? error) }; }
  });
  result.error = result.error ? sanitize(result.error, state.layout) : null;
  await stopApp(state);
  const file = JSON.parse(await readFile(state.settingsPath, "utf8"));
  return { ipc: result, fileValue: file.launch_at_login,
    registry: publicEntries(runEntries(state.exe), state.layout) };
}

async function restoreRegistry(state, initial) {
  // The fresh runner must not start with any SiteIndex login item. Delete only entries created by this test.
  if (initial.length) throw new Error("Pre-existing SiteIndex startup item on hosted runner; refusing cleanup");
  const created = runEntries(state.exe);
  for (const entry of created) command("reg.exe", ["delete", RUN_KEY, "/v", entry.name, "/f"]);
  assert.deepEqual(runEntries(state.exe), [], "Test-created startup item remains after cleanup");
  return created.length ? "registry fallback" : "UI/IPC restore";
}

async function runVersion(packageInfo, installer, index) {
  const layout = createWindowsProfileLayout(path.join(root, `version-${packageInfo.version}`));
  const state = { layout, exe: path.join(layout.installDir, "SiteIndex.exe"),
    settingsPath: path.join(layout.appDataRoot, "SiteIndex", "settings.json"),
    port: 9460 + index, browser: null, process: null, redirect: null, installed: false };
  current = state;
  const result = { version: packageInfo.version, sha256: await digest(installer),
    picker: "not attempted", startupBefore: [], startupAfterInstall: [],
    on: null, off: null, diagnostic: null, restore: null, outcome: "pending" };
  report.versions.push(result);
  assert.equal(result.sha256, packageInfo.sha256, `Official ${packageInfo.version} EXE SHA256 mismatch`);
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  const checks = await inspectWindowsProfileLayout(layout);
  assert(Object.values(checks).every((item) => item.withinRoot && item.noReparse), "Profile path escaped isolated root");
  state.redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  state.redirect.redirect();
  const probe = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { env: env(layout) });
  assert.equal(probe.stdout.trim().toLowerCase(), layout.appDataRoot.toLowerCase(), "Native AppData escaped profile");
  const initial = runEntries(state.exe);
  assert.deepEqual(initial, [], "Hosted runner already has a SiteIndex startup item");
  result.startupBefore = publicEntries(initial, layout);
  try {
    command(installer, ["/S", `/D=${layout.installDir}`], { env: env(layout), timeout: 300_000 });
    state.installed = true;
    assert(await exists(state.exe), "Official NSIS did not install SiteIndex.exe");
    result.startupAfterInstall = publicEntries(runEntries(state.exe), layout);
    result.on = await toggle(state, true);
    result.picker = "cancelled via native dialog";
    result.off = await toggle(state, false);
    const onOk = !result.on.ui.actionError && result.on.ui.afterChecked === true
      && result.on.ui.toast.includes("已保存") && result.on.ipc.value === true
      && result.on.fileValue === true && result.on.registry.length > 0;
    const offOk = !result.off.ui.actionError && result.off.ui.afterChecked === false
      && result.off.ui.toast.includes("已保存") && result.off.ipc.value === false
      && result.off.fileValue === false && result.off.registry.length === 0;
    if (!onOk || !offOk) {
      result.outcome = "reproduced";
      // Use a separate clean profile for IPC-only diagnosis, without writing config files directly.
      await cleanupVersion(state, initial);
      current = null;
      result.diagnostic = await runDiagnostic(packageInfo, installer, index + 10);
    } else result.outcome = "passed";
  } finally {
    if (current === state) { await cleanupVersion(state, initial); current = null; }
    result.restore = state.restore ?? null;
  }
  return result;
}

async function cleanupVersion(state, initial) {
  await stopApp(state).catch(() => undefined);
  state.restore = await restoreRegistry(state, initial);
  if (state.installed && await exists(path.join(state.layout.installDir, "Uninstall SiteIndex.exe"))) {
    command(path.join(state.layout.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: env(state.layout) });
  }
  assert.deepEqual(runEntries(state.exe), initial, "SiteIndex startup item differs from pre-test state after uninstall");
  if (state.redirect?.hasChanges && !state.redirect.restored)
    assert(state.redirect.restore(), "AppData registry redirect could not be restored");
}

async function runDiagnostic(packageInfo, installer, index) {
  const layout = createWindowsProfileLayout(path.join(root, `diagnostic-${packageInfo.version}`));
  const state = { layout, exe: path.join(layout.installDir, "SiteIndex.exe"),
    settingsPath: path.join(layout.appDataRoot, "SiteIndex", "settings.json"),
    port: 9460 + index, browser: null, process: null, redirect: null, installed: false };
  current = state;
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  const checks = await inspectWindowsProfileLayout(layout);
  assert(Object.values(checks).every((item) => item.withinRoot && item.noReparse), "Diagnostic profile escaped isolated root");
  state.redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  state.redirect.redirect();
  const initial = runEntries(state.exe);
  try {
    command(installer, ["/S", `/D=${layout.installDir}`], { env: env(layout), timeout: 300_000 });
    state.installed = true;
    return await ipcDiagnostic(state);
  } finally {
    await cleanupVersion(state, initial);
    current = null;
  }
}

try {
  report.sourceCommit = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  for (let index = 0; index < PACKAGES.length; index++)
    await runVersion(PACKAGES[index], installers[index], index);
  report.result = "completed"; // A reproduced old-version defect is recorded as a finding, not a CI pass claim.
} catch (error) {
  report.result = "blocked";
  report.failure = sanitize(error?.message ?? error, current?.layout ?? { root });
} finally {
  if (current) {
    try { await cleanupVersion(current, []); } catch (error) {
      report.cleanupError = sanitize(error?.message ?? error, current.layout);
    }
  }
  if (report.result === "completed" && !report.cleanupError) {
    try {
      const relative = path.relative(path.resolve(process.env.RUNNER_TEMP), path.resolve(root));
      assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Cleanup target escaped runner temp");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      if (error?.code === "EBUSY") report.cleanupWarning = "Installed directory remained temporarily busy on disposable hosted runner";
      else report.cleanupError = sanitize(error?.message ?? error, { root });
    }
  }
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (report.result !== "completed" || report.cleanupError) process.exitCode = 1;
