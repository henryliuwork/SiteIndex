import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const origin = "https://vault.example.test";
const versions = [
  ["0.7.6", "303d5fd725bb6f6f1e310b86d2bfe747b6b5f560548e87bae77ad98de6388514"],
  ["0.8.0", "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22"],
];
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"#82 diagnosis requires a fresh hosted Windows runner");
const installers = process.argv.slice(2).map((value) => path.resolve(value));
assert(installers.length === 2, "Two official NSIS EXEs are required");
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-794-"));
const report = { result: "pending", versions: [], failure: null };
const reportDir = path.resolve("siteindex-v082-vault-diagnostic-results");
let active;
let cleanupBlocked = false;

function call(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 300_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} exit ${result.status ?? "unknown"}`);
  return result;
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function env(layout) {
  const value = windowsProfileEnvironment(layout, process.env);
  value.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = layout.root;
  value.ELECTRON_RENDERER_URL = "";
  value.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete value[key];
  return value;
}
function safe(error, layout) {
  return String(error?.message ?? error ?? "").replaceAll(layout.root, "<isolated>")
    .replaceAll(process.cwd(), "<checkout>").replaceAll("fixture-only-password", "<redacted>")
    .replaceAll(/https?:\/\/[^\s"']+/gu, "<synthetic-origin>").slice(0, 1500);
}
function cancelPicker(pid) {
  const script = `
    Add-Type -Namespace SI -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
    $targetProcessId = ${pid}; $deadline = (Get-Date).AddSeconds(35)
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
  if (result.status !== 0) throw new Error(`Native picker cancellation failed (${result.status ?? "unknown"})`);
}
async function exitNormally(state) {
  assert(state.process, "No packaged app process to close");
  state.exitAttempted = true;
  const started = Date.now();
  const code = `
    Add-Type -Namespace SI -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
    $target = Get-Process -Id ${state.process.pid} -ErrorAction SilentlyContinue
    if (-not $target -or $target.Path -ine $env:SITEINDEX_ACCEPTANCE_INSTALL_EXE -or $target.MainWindowHandle -eq 0) { exit 2 }
    if (-not [SI.Native]::PostMessage($target.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 3 }
  `;
  call("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { env: { ...env(state.layout), SITEINDEX_ACCEPTANCE_INSTALL_EXE: state.exe }, timeout: 20_000 });
  const deadline = Date.now() + 30_000;
  while (state.process.exitCode === null && Date.now() < deadline) await delay(250);
  assert(state.process.exitCode !== null, "Normal WM_CLOSE did not exit the packaged app");
  assert.equal(state.process.exitCode, 0, "Packaged app exited with a nonzero code after WM_CLOSE");
  let remainingCount = 1;
  const childrenDeadline = Date.now() + 10_000;
  while (remainingCount && Date.now() < childrenDeadline) {
    const remaining = call("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $expected }).Count"],
    { env: { ...env(state.layout), SITEINDEX_ACCEPTANCE_INSTALL_EXE: state.exe }, timeout: 20_000 });
    remainingCount = Number(remaining.stdout.trim());
    if (remainingCount) await delay(250);
  }
  assert.equal(remainingCount, 0, "Packaged app still has running processes after WM_CLOSE");
  if (state.browser) { await state.browser.close().catch(() => undefined); state.browser = null; }
  state.process = null;
  return Date.now() - started;
}
async function launch(state) {
  const endpoint = `http://127.0.0.1:${state.port}`;
  assert(!await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false), "CDP port busy");
  state.process = spawn(state.exe, [`--remote-debugging-port=${state.port}`, "--disable-gpu"], {
    cwd: state.layout.root, env: env(state.layout), windowsHide: true, stdio: "ignore",
  });
  state.exitAttempted = false;
  state.process.on("error", () => undefined);
  cancelPicker(state.process.pid);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) await delay(300);
  state.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  let page;
  while (Date.now() < deadline + 30_000 && !page) {
    page = state.browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (!page) await delay(300);
  }
  assert(page, "Packaged UI did not open after native picker cancellation");
  await page.waitForFunction(() => Boolean(window.siteindex?.settings?.get), null, { timeout: 20_000 });
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await page.locator("#si-device-name").waitFor();
  return page;
}
async function vaultFileState(layout) {
  const filename = `wordpress-${createHash("sha256").update(origin).digest("hex")}.vault.json`;
  const file = path.join(layout.vaultPath, filename);
  const relative = path.win32.relative(layout.localAppDataRoot, file);
  const withinLocalAppData = Boolean(relative) && !relative.startsWith("..") && !path.win32.isAbsolute(relative);
  assert(withinLocalAppData, "Vault path escaped isolated LOCALAPPDATA");
  try { return { exists: true, bytes: (await stat(file)).size, withinLocalAppData }; }
  catch (error) { if (error?.code === "ENOENT") return { exists: false, bytes: null, withinLocalAppData }; throw error; }
}
async function checkVersion(version, expectedHash, installer, index) {
  const layout = createWindowsProfileLayout(path.join(root, `version-${version}`));
  const state = { layout, exe: path.join(layout.installDir, "SiteIndex.exe"), port: 9550 + index,
    process: null, browser: null, redirect: null, installed: false, exitAttempted: false };
  active = state;
  const row = { version, exeSha256: null, initialStatus: null, sameSessionStatus: null,
    restartedStatus: null, safeStorageAvailable: null, safeStorageAfterRestart: null,
    closeToTrayUi: null, closeToTrayIpc: null, normalExitMs: null,
    normalExitConfirmed: false, vaultAfterSave: null,
    vaultAfterRestart: null, uiError: null, outcome: "pending" };
  report.versions.push(row);
  row.exeSha256 = createHash("sha256").update(await readFile(installer)).digest("hex");
  assert.equal(row.exeSha256, expectedHash, `Official v${version} EXE digest mismatch`);
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  const checks = await inspectWindowsProfileLayout(layout);
  assert(Object.values(checks).every((check) => check.withinRoot && check.noReparse), "Profile escaped isolated root");
  state.redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  state.redirect.redirect();
  try {
    call(installer, ["/S", `/D=${layout.installDir}`], { env: env(layout) });
    state.installed = true;
    const page = await launch(state);
    assert.equal(await page.evaluate(() => window.siteindex.app.version()), version, "Packaged app version mismatch");
    const created = await page.evaluate(async (input) => {
      const workspace = await window.siteindex.projects.createWorkspaceOnly(input);
      await window.siteindex.projects.updateConfig(workspace.id, { edm: { image_host: { type: "wordpress" } } });
      return workspace.id;
    }, { url: origin, brand: { name: "Synthetic Vault Project" }, markets: ["US"],
      projects_root: layout.projectRoot, folder_name: "synthetic-vault-project",
      workspace: { enabled: true, platform: "woocommerce", esp_presets: [] } });
    assert.equal(created, "synthetic-vault-project");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "WordPress 图片托管凭据" }).waitFor();
    const trayToggle = page.getByRole("checkbox", { name: "关闭窗口时最小化到托盘" });
    await trayToggle.uncheck();
    await page.waitForFunction(async () => (await window.siteindex.settings.get()).close_to_tray === false);
    row.closeToTrayUi = await trayToggle.isChecked();
    row.closeToTrayIpc = (await page.evaluate(() => window.siteindex.settings.get())).close_to_tray;
    assert(row.closeToTrayUi === false && row.closeToTrayIpc === false,
      "Normal window close setting did not save through packaged UI");
    row.initialStatus = (await page.evaluate((site) => window.siteindexWindow.wordpressCredentials.status(site), origin)).state;
    row.safeStorageAvailable = row.initialStatus !== "unavailable";
    if (!row.safeStorageAvailable) {
      row.vaultAfterSave = await vaultFileState(layout);
      row.normalExitMs = await exitNormally(state);
      row.normalExitConfirmed = true;
      const fresh = await launch(state);
      row.restartedStatus = (await fresh.evaluate((site) => window.siteindexWindow.wordpressCredentials.status(site), origin)).state;
      row.safeStorageAfterRestart = row.restartedStatus !== "unavailable";
      row.vaultAfterRestart = await vaultFileState(layout);
      row.outcome = "unavailable";
      return row;
    }
    try {
      await page.getByRole("button", { name: "配置凭据" }).first().click();
      await page.locator("#si-wp-username").fill("fixture-only-user");
      await page.locator("#si-wp-application-password").fill("fixture-only-password");
      await page.getByRole("button", { name: "保存到本机" }).click();
      await page.waitForFunction(async (site) =>
        (await window.siteindexWindow.wordpressCredentials.status(site)).state === "configured", origin, { timeout: 12_000 });
    } catch (error) { row.uiError = safe(error, layout); }
    row.sameSessionStatus = (await page.evaluate((site) => window.siteindexWindow.wordpressCredentials.status(site), origin)).state;
    row.vaultAfterSave = await vaultFileState(layout);
    row.normalExitMs = await exitNormally(state);
    row.normalExitConfirmed = true;
    const fresh = await launch(state);
    row.restartedStatus = (await fresh.evaluate((site) => window.siteindexWindow.wordpressCredentials.status(site), origin)).state;
    row.safeStorageAfterRestart = row.restartedStatus !== "unavailable";
    row.vaultAfterRestart = await vaultFileState(layout);
    row.outcome = row.sameSessionStatus === "configured" && row.restartedStatus === "configured" && !row.uiError
      && row.vaultAfterSave.exists && row.vaultAfterRestart.exists ? "passed" : "reproduced";
    return row;
  } catch (error) { row.outcome = "blocked"; row.error = safe(error, layout); return row; }
  finally {
    if (state.process && !state.exitAttempted) {
      try { await exitNormally(state); }
      catch (error) { row.outcome = "blocked"; row.cleanupError = safe(error, layout); }
    }
    if (state.process) {
      cleanupBlocked = true;
      row.outcome = "blocked";
      row.cleanupError ??= "Packaged app did not exit normally";
    }
    if (!state.process && state.installed && await exists(path.join(layout.installDir, "Uninstall SiteIndex.exe")))
      call(path.join(layout.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: env(layout) });
    if (state.redirect?.hasChanges && !state.redirect.restored)
      assert(state.redirect.restore(), "AppData redirect restore failed");
    active = null;
  }
}
try {
  for (let index = 0; index < versions.length; index++)
    await checkVersion(versions[index][0], versions[index][1], installers[index], index);
  report.result = report.versions.every((row) => row.outcome !== "blocked") ? "completed" : "blocked";
} catch (error) { report.result = "blocked"; report.failure = safe(error, active?.layout ?? { root }); }
finally {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  const relative = path.relative(path.resolve(process.env.RUNNER_TEMP), path.resolve(root));
  if (!cleanupBlocked && relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
}
if (report.result !== "completed") process.exitCode = 1;
