import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const baselineHash = "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22";
const projectId = "synthetic-entry-project";
const fields = [
  [61, "runner", "local"],
  [62, "readme.overview", "Synthetic project overview."],
  [63, "readme.focus", "Review synthetic products this week."],
  [64, "readme.rules", "Use only example.test synthetic data."],
  [65, "todo.status", "in_progress"],
  [66, "todo.note", "Synthetic review note."],
];
const input = process.argv.slice(2).map((item) => path.resolve(item));
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"Project config acceptance requires a fresh GitHub-hosted Windows runner");
assert(input.length === 2 && process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256,
  "Official baseline and pinned candidate installers are required");
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-entries-"));
let layout; let exe; let targetFile; let todoKey; let historyFile;
const reportDir = path.resolve("siteindex-v082-independent-entries-results");
const report = { result: "pending", stage: "prepare", baselineSha256: null,
  candidateSha256: null, rows: fields.map(([id, key]) => ({ id, key, uiSaved: false,
    baselineExitMode: null, baselineFile: false, baselineApi: false, candidateInstalled: false,
    installerByteIdentical: false, candidateFile: false, candidateApi: false,
    candidateUi: false, historyPreserved: null, candidateExitMode: null, outcome: "unverified" })), failure: null };
let redirect; let installed = false; let appProcess; let browser;

const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const sectionTitles = { 62: "项目概况", 63: "当前重点", 64: "工作规则与偏好" };
const blockKeys = { 62: "overview", 63: "focus", 64: "rules" };
const todoFixture = { url: "https://config.example.test/synthetic-page", rule: "title_missing",
  severity: "mid", detail: "Synthetic missing title", status: "open",
  first_seen: "2026-11-24", last_seen: "2026-11-24" };
async function readFileValue(id) {
  if (id === 61) return JSON.parse(await readFile(targetFile, "utf8")).device_id;
  if (id <= 64) {
    const markdown = await readFile(targetFile, "utf8");
    const title = sectionTitles[id];
    const match = markdown.match(new RegExp(`(?:^|\\n)## ${title}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, "u"));
    return match?.[1].trim();
  }
  const states = (await readFile(targetFile, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const state = states.find((item) => item.dedupe_key === todoKey);
  return id === 65 ? state?.status : state?.note;
}
async function apiValue(page, id) {
  if (id === 61) {
    const state = await page.evaluate((project) => window.siteindex.runner.get(project), projectId);
    return state.is_this_device && state.runner?.device_id === state.this_device.device_id ? state.runner.device_id : null;
  }
  if (id <= 64) return (await page.evaluate((project) => window.siteindex.readme.get(project), projectId)).user_blocks[blockKeys[id]];
  const result = await page.evaluate((project) => window.siteindex.todos.list(project), projectId);
  const state = result.items.find((item) => item.finding.dedupe_key === todoKey)?.state;
  return id === 65 ? state?.status : state?.note;
}
function environment() {
  const env = windowsProfileEnvironment(layout, process.env);
  env.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = layout.root;
  env.ELECTRON_RENDERER_URL = "";
  env.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
  return env;
}
function safe(error) {
  return String(error?.message ?? error ?? "").replaceAll(root, "<isolated>")
    .replaceAll(process.cwd(), "<checkout>").replaceAll(/https?:\/\/[^\s"']+/gu, "<synthetic-url>").slice(0, 1200);
}
function call(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 300_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} exited ${result.status ?? "unknown"}`);
}
function cancelPicker(pid) {
  const code = `
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
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { encoding: "utf8", windowsHide: true, timeout: 45_000 });
  if (result.status !== 0) throw new Error(`Native picker cancellation failed (${result.status ?? "unknown"})`);
}
async function stop(requireUiExit = false) {
  let mode = "already-exited";
  if (appProcess?.exitCode === null && browser) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (page && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => undefined);
    const deadline = Date.now() + 15_000;
    while (appProcess.exitCode === null && Date.now() < deadline) await delay(250);
    if (appProcess.exitCode !== null) mode = "ui-close";
  }
  if (browser) { await browser.close().catch(() => undefined); browser = null; }
  if (appProcess?.exitCode === null) { appProcess.kill(); mode = "forced"; }
  appProcess = null;
  if (!await exists(exe)) return;
  call("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'SiteIndex.exe' -and $_.ExecutablePath -ieq $expected } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
  { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: exe }, timeout: 20_000 });
  await delay(500);
  if (requireUiExit) assert.equal(mode, "ui-close", "Packaged UI did not exit normally");
  return mode;
}
async function launch() {
  const endpoint = "http://127.0.0.1:9561";
  assert(!await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false), "CDP port is occupied");
  appProcess = spawn(exe, ["--remote-debugging-port=9561", "--disable-gpu"],
    { cwd: root, env: environment(), windowsHide: true, stdio: "ignore" });
  appProcess.on("error", () => undefined);
  cancelPicker(appProcess.pid);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) await delay(300);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  let page;
  while (Date.now() < deadline + 30_000 && !page) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (!page) await delay(300);
  }
  assert(page, "Packaged UI did not open");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForFunction(() => Boolean(window.siteindex?.projects?.get), null, { timeout: 20_000 });
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  const closeToTray = page.getByLabel("关闭窗口时最小化到托盘");
  await closeToTray.waitFor();
  if (await closeToTray.isChecked()) {
    await closeToTray.click();
    await page.waitForFunction(async () => !(await window.siteindex.settings.get()).close_to_tray);
  }
  return page;
}
async function route(page, id) {
  const tail = id === 61 ? "runs" : id <= 64 ? "readme" : "todos";
  await page.evaluate(({ project, pageName }) => { window.location.hash = `#/p/${project}/${pageName}`; },
    { project: projectId, pageName: tail });
  await page.waitForFunction((pageName) => window.location.hash.endsWith(`/${pageName}`), tail);
}
async function compareRow(page, stage, index) {
  const [id, key, expected] = fields[index];
  const fileValue = await readFileValue(id);
  const api = await apiValue(page, id);
  const row = report.rows[index];
  row[`${stage}File`] = id === 61 ? Boolean(fileValue) : fileValue === expected;
  row[`${stage}Api`] = id === 61 ? Boolean(api && api === fileValue) : api === expected;
  assert(row[`${stage}File`] && row[`${stage}Api`], `#${id} ${key} ${stage} readback mismatch`);
}
async function openTodo(page) {
  const result = await page.evaluate((id) => window.siteindex.todos.list(id), projectId);
  const item = result.items.find((row) => row.finding.rule_id === "seo.issue.title_missing");
  assert(item, "Synthetic SEO finding was not generated");
  todoKey = item.finding.dedupe_key;
  await route(page, 65);
  await page.getByText(item.finding.title, { exact: true }).first().click();
  await page.getByRole("combobox", { name: "更新待办状态" }).waitFor();
}
async function editField(page, index) {
  const [id, , expected] = fields[index];
  if (id === 61) {
    await route(page, id);
    await page.getByRole("button", { name: "改为本机" }).click();
    await page.waitForFunction(async (project) => (await window.siteindex.runner.get(project)).is_this_device, projectId);
    await page.getByText("本机已设为此项目的执行设备。").waitFor({ state: "visible", timeout: 5000 });
  } else if (id <= 64) {
    await route(page, id);
    const card = page.locator(".si-readme-user-card");
    if (id === 64) await card.getByRole("button", { name: "编辑", exact: true }).click();
    await card.getByRole("textbox", { name: sectionTitles[id] }).fill(expected);
    await card.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(async ({ project, block, value }) =>
      (await window.siteindex.readme.get(project)).user_blocks[block] === value,
    { project: projectId, block: blockKeys[id], value: expected });
  } else {
    await openTodo(page);
    if (id === 65) {
      await page.getByRole("combobox", { name: "更新待办状态" }).click();
      await page.getByRole("option", { name: "进行中" }).click();
      await page.getByRole("button", { name: "保存状态" }).click();
    } else {
      await page.getByRole("textbox", { name: "编辑待办备注" }).fill(expected);
      await page.getByRole("button", { name: "保存备注" }).click();
    }
    await page.waitForFunction(async ({ project, key, field, value }) => {
      const item = (await window.siteindex.todos.list(project)).items.find((row) => row.finding.dedupe_key === key);
      return item?.state[field] === value;
    }, { project: projectId, key: todoKey, field: id === 65 ? "status" : "note", value: expected });
  }
  report.rows[index].uiSaved = true;
}
async function checkCandidateUi(page, id, expected) {
  if (id === 61) {
    await route(page, id);
    await page.locator(".si-runs-device-inline").getByText(/（本机）/u).waitFor();
    return await page.locator(".si-runs-device-inline").getByText(/（本机）/u).isVisible()
      && await page.getByRole("button", { name: "改为本机" }).count() === 0;
  }
  if (id <= 64) {
    await route(page, id);
    if (id === 64) await page.locator(".si-readme-user-card").getByRole("button", { name: "编辑", exact: true }).click();
    return (await page.getByRole("textbox", { name: sectionTitles[id] }).inputValue()) === expected;
  }
  await openTodo(page);
  return id === 65 ? (await page.getByRole("combobox", { name: "更新待办状态" }).innerText()).includes("进行中")
    : (await page.getByRole("textbox", { name: "编辑待办备注" }).inputValue()) === expected;
}
async function checkField(index) {
  const [id, key, expected] = fields[index];
  const row = report.rows[index];
  layout = createWindowsProfileLayout(path.join(root, `field-${id}`));
  exe = path.join(layout.installDir, "SiteIndex.exe");
  const projectDir = path.join(layout.projectRoot, projectId);
  targetFile = path.join(projectDir, id === 61 ? "_site-index/.runner.json"
    : id <= 64 ? "README.md" : "_site-index/todos/manual-state.jsonl");
  historyFile = id >= 65 ? path.join(projectDir, "_site-index/todos/history.jsonl") : null;
  todoKey = null;
  installed = false;
  redirect = null;
  try {
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  const checks = await inspectWindowsProfileLayout(layout);
  assert(Object.values(checks).every((item) => item.withinRoot && item.noReparse), "Profile isolation failed");
  redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();
  report.stage = `#${id} baseline install`;
  call(input[0], ["/S", `/D=${layout.installDir}`], { env: environment() });
  installed = true;
  let page = await launch();
  assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.0");
  const created = await page.evaluate((data) => window.siteindex.projects.createWorkspaceOnly(data), {
    url: "https://config.example.test", brand: { name: "Synthetic Config Project" }, markets: ["US"],
    projects_root: layout.projectRoot, folder_name: projectId,
    workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
  });
  assert.equal(created.id, projectId);
  if (id >= 65) {
    const issuePath = path.join(projectDir, "_site-index/seo/issues.jsonl");
    await mkdir(path.dirname(issuePath), { recursive: true });
    await writeFile(issuePath, `${JSON.stringify(todoFixture)}\n`);
    await stop(true); // Reopen so Core reads only this synthetic source fixture.
    page = await launch();
  }
  report.stage = `#${id} baseline UI save`;
  await editField(page, index);
  row.baselineExitMode = await stop(true);
  report.stage = `#${id} exited baseline file readback`;
  const savedValue = await readFileValue(id);
  row.baselineFile = id === 61 ? Boolean(savedValue) : savedValue === expected;
  assert(row.baselineFile, `#${id} exited baseline file mismatch`);
  const baselineHistory = historyFile ? await readFile(historyFile) : null;
  if (baselineHistory) {
    const entries = baselineHistory.toString("utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const action = id === 65 ? "status_changed" : "note_changed";
    assert(entries.some((entry) => entry.dedupe_key === todoKey && entry.action === action),
      `#${id} todo history event missing`);
  }
  page = await launch();
  report.stage = `#${id} new baseline process API readback`;
  await compareRow(page, "baseline", index);
  const baselineBytes = await readFile(targetFile);
  await stop(true);
  report.stage = `#${id} pinned candidate overwrite install`;
  call(input[1], ["/S", `/D=${layout.installDir}`], { env: environment() });
  row.candidateInstalled = true;
  row.installerByteIdentical = (await readFile(targetFile)).equals(baselineBytes);
  assert(row.installerByteIdentical, `#${id} installer rewrote ${key}`);
  if (baselineHistory) {
    row.historyPreserved = (await readFile(historyFile)).equals(baselineHistory);
    assert(row.historyPreserved, `#${id} installer rewrote todo history`);
  }
  page = await launch();
  assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.2");
  report.stage = `#${id} candidate file and API readback`;
  await compareRow(page, "candidate", index);
  report.stage = `#${id} candidate UI readback`;
  row.candidateUi = await checkCandidateUi(page, id, expected);
  assert(row.candidateUi, `#${id} candidate UI readback mismatch`);
  row.candidateExitMode = await stop(true);
  row.outcome = "passed";
  } catch (error) {
    row.outcome = "failed";
    row.error = safe(error);
    throw error;
  } finally {
    let cleanupError;
    try { await stop(); } catch (error) { cleanupError = error; }
    if (installed && await exists(path.join(layout.installDir, "Uninstall SiteIndex.exe"))) {
      try { call(path.join(layout.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: environment() }); }
      catch (error) { cleanupError ??= error; }
    }
    if (redirect?.hasChanges && !redirect.restored && !redirect.restore())
      cleanupError ??= new Error("Isolated AppData redirect was not restored");
    if (!redirect?.hasChanges || redirect.restored)
      await rm(layout.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
    if (cleanupError) { row.outcome = "failed"; row.error = safe(cleanupError); throw cleanupError; }
  }
}
try {
  report.stage = "provenance";
  report.baselineSha256 = await hash(input[0]);
  report.candidateSha256 = await hash(input[1]);
  assert.equal(report.baselineSha256, baselineHash, "Official v0.8.0 EXE SHA256 mismatch");
  assert.equal(report.candidateSha256, process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256.toLowerCase(),
    "Pinned candidate EXE SHA256 mismatch");
  for (let index = 0; index < fields.length; index++) await checkField(index);
  report.result = "passed";
}
catch (error) { report.result = "failed"; report.failure = safe(error); }
finally {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!redirect?.hasChanges || redirect.restored)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
}
if (report.result !== "passed") process.exitCode = 1;
