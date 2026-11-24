import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectContainedPath, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const baselineSha = "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22";
const projectId = "synthetic-task83-project";
const jobs = ["daily", "validate", "weekly", "readme", "monthly"];
const expected = {
  daily: { time: "17:44", days: ["Tuesday", "Thursday"] },
  validate: { time: "02:30", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
  weekly: { time: "03:00", days: ["Monday"] },
  readme: { time: "05:00", days: ["Sunday"] },
  monthly: { time: "04:00", day: "1" },
};
const installers = process.argv.slice(2).map((item) => path.resolve(item));
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"#83 requires a fresh GitHub-hosted Windows runner");
assert(installers.length === 2 && /^[0-9a-f]{64}$/i.test(process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256 ?? ""),
  "Official baseline and exact pinned candidate are required");

const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-task83-"));
const layout = createWindowsProfileLayout(root);
const exe = path.join(layout.installDir, "SiteIndex.exe");
const projectPath = path.join(layout.projectRoot, projectId);
const siteFile = path.join(projectPath, "_site-index", "site.json");
const reportDir = path.resolve("siteindex-v082-schedule-system-results");
const report = { result: "pending", stage: "prepare", baselineSha: null, candidateSha: null,
  uiSaved: false, baselineExitCode: null, baselineFile: false, baselineApi: false,
  baselineSystem: {}, candidateInstalled: false, candidateExitCode: null,
  candidateFile: false, candidateApi: false, candidateSystem: {}, disabled: false,
  cleanup: { tasksAbsent: false, appStopped: false, uninstalled: false, profileRestored: false }, failure: null };
let redirect; let processHandle; let browser; let installed = false; let syntheticTasksOwned = false;

const taskName = (job) => `\\SiteIndex\\${projectId}-${job}`;
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
function environment() {
  const env = windowsProfileEnvironment(layout, process.env);
  env.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = root;
  env.ELECTRON_RENDERER_URL = "";
  env.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
  return env;
}
function safe(error) {
  return String(error?.message ?? error).replaceAll(root, "<synthetic-root>")
    .replaceAll(process.cwd(), "<checkout>").replaceAll(/https?:\/\/[^\s"']+/gu, "<synthetic-url>").slice(0, 1200);
}
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 300_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} exit ${result.status ?? "unknown"}`);
  return result.stdout;
}
async function assertContained(candidate) {
  const check = await inspectContainedPath(root, candidate);
  assert(check.withinRoot && check.noReparse, "Synthetic path escaped runner root");
}
function remainingProcesses() {
  const code = "$exe = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $exe }).Count";
  return Number(command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: exe }, timeout: 20_000 }).trim());
}
async function normalExit() {
  assert(processHandle && browser, "No installed app is running");
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
  assert(page && !page.isClosed(), "Installed UI page is unavailable for normal exit");
  await page.evaluate(() => window.close()).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (processHandle.exitCode === null && Date.now() < deadline) await delay(250);
  assert.equal(processHandle.exitCode, 0, "Packaged app did not exit normally with code 0");
  let count = remainingProcesses();
  const childDeadline = Date.now() + 10_000;
  while (count && Date.now() < childDeadline) { await delay(250); count = remainingProcesses(); }
  assert.equal(count, 0, "Installed app left same-path processes after normal exit");
  await browser.close(); browser = null; processHandle = null;
  return 0;
}
async function launch(version) {
  const endpoint = "http://127.0.0.1:9583";
  assert(!await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false), "CDP port occupied");
  processHandle = spawn(exe, ["--remote-debugging-port=9583", "--disable-gpu"],
    { cwd: root, env: environment(), windowsHide: true, stdio: "ignore" });
  processHandle.on("error", () => undefined);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) await delay(300);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  let page;
  while (Date.now() < deadline && !page) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (!page) await delay(300);
  }
  assert(page, "Installed UI did not open");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForFunction(() => Boolean(window.siteindex?.schedule?.verify), null, { timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.siteindex.app.version()), version);
  return page;
}
function systemTask(job) {
  const name = taskName(job);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$raw = & schtasks.exe /Query /TN $env:SITEINDEX_TASK_NAME /XML 2>&1 | Out-String",
    "if ($LASTEXITCODE -ne 0) { throw 'Task Scheduler query failed' }",
    "[xml]$doc = $raw",
    "$pick = { param($name) $node = $doc.SelectSingleNode(\"//*[local-name()='$name']\"); if ($node) { $node.InnerText } else { $null } }",
    "$trigger = $doc.SelectSingleNode(\"//*[local-name()='CalendarTrigger']\")",
    "$week = $doc.SelectNodes(\"//*[local-name()='DaysOfWeek']/*\") | ForEach-Object { $_.LocalName }",
    "$month = $doc.SelectNodes(\"//*[local-name()='DaysOfMonth']/*[local-name()='Day']\") | ForEach-Object { $_.InnerText }",
    "[pscustomobject]@{ command = & $pick 'Command'; arguments = & $pick 'Arguments'; workingDirectory = & $pick 'WorkingDirectory'; startBoundary = & $pick 'StartBoundary'; triggerCount = $doc.SelectNodes(\"//*[local-name()='Triggers']/*\").Count; actionCount = $doc.SelectNodes(\"//*[local-name()='Actions']/*\").Count; triggerEnabled = $trigger.SelectSingleNode(\"*[local-name()='Enabled']\").InnerText; week = @($week); month = @($month) } | ConvertTo-Json -Compress -Depth 5",
  ].join("; ");
  const raw = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...environment(), SITEINDEX_TASK_NAME: name }, timeout: 20_000 });
  return JSON.parse(raw);
}
function taskAbsent(job) {
  const result = spawnSync("schtasks.exe", ["/Query", "/TN", taskName(job), "/XML"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  assert.equal(result.status, 1, "Task Scheduler query failed unexpectedly");
  assert(/cannot find|does not exist|not found|找不到|不存在/i.test(`${result.stdout}\n${result.stderr}`),
    "Task Scheduler query failed for a reason other than task absence");
  return true;
}
function assertXml(job, value) {
  const target = expected[job];
  assert.equal(value.command?.toLowerCase(), exe.toLowerCase(), `${job} executable path`);
  assert.equal(value.arguments, `--run-job "${projectPath}" ${job}`, `${job} arguments`);
  assert.equal(value.workingDirectory?.toLowerCase(), projectPath.toLowerCase(), `${job} working directory`);
  assert.equal(value.startBoundary?.slice(11, 16), target.time, `${job} trigger time`);
  assert.equal(value.triggerCount, 1, `${job} trigger count`);
  assert.equal(value.actionCount, 1, `${job} action count`);
  assert.equal(value.triggerEnabled ?? "true", "true", `${job} trigger enabled`);
  if (target.days) assert.deepEqual([...value.week].sort(), [...target.days].sort(), `${job} weekdays`);
  else assert.deepEqual(value.month, [target.day], `${job} monthly day`);
}
async function readBack(page, stage) {
  const file = JSON.parse(await readFile(siteFile, "utf8"));
  const api = await page.evaluate(async (id) => ({
    project: await window.siteindex.projects.get(id),
    schedule: await window.siteindex.schedule.get(id),
    verify: await window.siteindex.schedule.verify(id),
    runtime: await window.siteindex.schedule.status(),
    tasks: await window.siteindex.schedule.listSystemTasks(),
  }), projectId);
  const rows = api.tasks.filter((row) => row.projectId === projectId);
  const inspected = {};
  const diagnostics = {
    verify: { state: api.verify.state, message: api.verify.message?.replaceAll(root, "<synthetic-root>") ?? null },
    runtime: api.runtime,
    registered: api.schedule.registered,
    fileDaily: file.schedule?.daily ?? null,
    apiDaily: api.schedule.config.daily,
    taskNames: rows.map((row) => row.taskName),
    system: {},
  };
  report[`${stage}Diagnostics`] = diagnostics;
  for (const job of jobs) {
    try {
      const xml = systemTask(job);
      inspected[job] = xml;
      diagnostics.system[job] = { time: xml.startBoundary?.slice(11, 16),
        weekdays: xml.week, monthDay: xml.month, triggerCount: xml.triggerCount,
        actionCount: xml.actionCount, triggerEnabled: xml.triggerEnabled,
        command: xml.command?.replaceAll(root, "<synthetic-root>"),
        arguments: xml.arguments?.replaceAll(root, "<synthetic-root>"),
        workingDirectory: xml.workingDirectory?.replaceAll(root, "<synthetic-root>") };
    } catch (error) { diagnostics.system[job] = { error: safe(error) }; }
  }
  assert.deepEqual(file.schedule, api.schedule.config, `${stage} file/API schedule mismatch`);
  assert.deepEqual(file.schedule, api.project.config.schedule, `${stage} project API mismatch`);
  assert.deepEqual(file.schedule.daily, { enabled: true, days: [2, 4], time: "17:44" });
  assert.equal(api.verify.state, "ok", `${stage} packaged verification failed`);
  assert.equal(rows.length, jobs.length, `${stage} packaged system task count`);
  for (const job of jobs) {
    assert(rows.some((row) => row.taskName.toLowerCase() === taskName(job).toLowerCase()), `${stage} missing ${job} IPC task`);
    const xml = inspected[job];
    assert(xml, `${stage} ${job} system task XML could not be read`);
    assertXml(job, xml);
    report[`${stage}System`][job] = diagnostics.system[job];
  }
  report[`${stage}File`] = true;
  report[`${stage}Api`] = true;
}
async function waitForScheduleReady(page, stage) {
  const deadline = Date.now() + 60_000;
  let consecutive = 0;
  let last = null;
  while (Date.now() < deadline) {
    const verify = await page.evaluate((id) => window.siteindex.schedule.verify(id), projectId);
    const available = jobs.filter((job) => {
      try { systemTask(job); return true; } catch { return false; }
    });
    last = { state: verify.state, message: verify.message?.replaceAll(root, "<synthetic-root>") ?? null,
      actualTaskCount: available.length };
    consecutive = verify.state === "ok" && available.length === jobs.length ? consecutive + 1 : 0;
    if (consecutive >= 2) { report[`${stage}Stability`] = last; return; }
    await delay(500);
  }
  report[`${stage}Stability`] = last;
  throw new Error(`${stage} system tasks and packaged verification did not stabilize`);
}
async function cleanupTasks() {
  for (const job of jobs) {
    if (taskAbsent(job)) continue;
    assert(syntheticTasksOwned, "Refusing to delete pre-existing system task");
    command("schtasks.exe", ["/Delete", "/TN", taskName(job), "/F"], { timeout: 20_000 });
  }
  report.cleanup.tasksAbsent = jobs.every(taskAbsent);
  assert(report.cleanup.tasksAbsent, "Synthetic system tasks remained after cleanup");
}

try {
  report.stage = "installer digests and isolated runner";
  report.baselineSha = await digest(installers[0]);
  report.candidateSha = await digest(installers[1]);
  assert.equal(report.baselineSha, baselineSha, "Official v0.8.0 installer SHA mismatch");
  assert.equal(report.candidateSha, process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256.toLowerCase(), "Pinned candidate SHA mismatch");
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  await assertContained(layout.projectRoot);
  assert(Object.values(await inspectWindowsProfileLayout(layout)).every((check) => check.withinRoot && check.noReparse),
    "Isolated profile escaped runner root");
  await mkdir(path.join(layout.appDataRoot, "SiteIndex"), { recursive: true });
  await writeFile(path.join(layout.appDataRoot, "SiteIndex", "settings.json"), `${JSON.stringify({
    device_id: "synthetic-task83-runner", device_name: "Synthetic runner",
    projects_root: layout.projectRoot, close_to_tray: false,
  })}\n`);
  assert(jobs.every(taskAbsent), "Synthetic task name already exists on runner");
  redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();

  report.stage = "official v0.8.0 UI save";
  command(installers[0], ["/S", `/D=${layout.installDir}`], { env: environment() }); installed = true;
  const page = await launch("0.8.0");
  syntheticTasksOwned = true;
  const created = await page.evaluate((data) => window.siteindex.projects.createWorkspaceOnly(data), {
    url: "https://task83.example.test", brand: { name: "Synthetic Scheduled Project" }, markets: ["US"],
    projects_root: layout.projectRoot, folder_name: projectId,
    workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
  });
  assert.equal(created.id, projectId);
  await page.evaluate((id) => { window.location.hash = `#/p/${id}/runs`; }, projectId);
  await page.getByRole("button", { name: "改为本机" }).click();
  await page.waitForFunction(async (id) => (await window.siteindex.runner.get(id)).is_this_device, projectId,
    { timeout: 30_000 });
  const row = page.locator(".si-schedule-row").filter({ has: page.getByText("每日同步", { exact: true }) });
  await row.getByRole("button", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑每日同步计划" });
  await dialog.getByRole("button", { name: "一", exact: true }).click();
  await dialog.getByRole("button", { name: "三", exact: true }).click();
  await dialog.getByRole("button", { name: "五", exact: true }).click();
  await dialog.getByRole("button", { name: "六", exact: true }).click();
  await dialog.getByRole("button", { name: "日", exact: true }).click();
  await dialog.getByLabel("执行时间").fill("17:44");
  await dialog.getByRole("button", { name: "保存计划" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  await page.waitForFunction(async (id) => {
    const value = await window.siteindex.schedule.get(id);
    return value.config.daily.time === "17:44" && value.registered;
  }, projectId, { timeout: 30_000 });
  report.uiSaved = true;
  await waitForScheduleReady(page, "baseline");
  await readBack(page, "baseline");
  report.baselineExitCode = await normalExit();
  assert(jobs.every((job) => !taskAbsent(job)), "System tasks vanished after normal exit");
  const baselineBytes = await readFile(siteFile);
  const reopened = await launch("0.8.0");
  await waitForScheduleReady(reopened, "baselineReopened");
  await readBack(reopened, "baseline");
  await normalExit();

  report.stage = "same-path pinned candidate overwrite";
  command(installers[1], ["/S", `/D=${layout.installDir}`], { env: environment() });
  report.candidateInstalled = true;
  assert((await readFile(siteFile)).equals(baselineBytes), "Candidate installer changed site.json");
  const upgraded = await launch("0.8.2");
  await waitForScheduleReady(upgraded, "candidate");
  await readBack(upgraded, "candidate");
  await upgraded.evaluate((id) => { window.location.hash = `#/p/${id}/runs`; }, projectId);
  await upgraded.locator(".si-schedule-row").filter({ has: upgraded.getByText("每日同步", { exact: true }) })
    .getByText("每周二、四 · 17:44", { exact: true }).waitFor();
  await upgraded.getByText("已注册到任务计划程序").waitFor();
  report.candidateExitCode = await normalExit();
  assert((await readFile(siteFile)).equals(baselineBytes), "Candidate startup changed site.json");
  assert(jobs.every((job) => !taskAbsent(job)), "System tasks vanished after candidate exit");

  report.stage = "disable and independent OS cleanup";
  const cleanupPage = await launch("0.8.2");
  const disabled = await cleanupPage.evaluate(async (id) => {
    const state = await window.siteindex.schedule.get(id);
    const config = structuredClone(state.config);
    for (const job of ["daily", "validate", "weekly", "readme", "monthly"]) config[job].enabled = false;
    return window.siteindex.schedule.save(id, config);
  }, projectId);
  assert(jobs.every((job) => disabled.config[job].enabled === false), "Packaged API did not disable schedule");
  assert(jobs.every(taskAbsent), "OS tasks survived packaged schedule.disable");
  report.disabled = true;
  await normalExit();
  report.result = "passed";
} catch (error) { report.result = "failed"; report.failure = safe(error); }
finally {
  const cleanupErrors = [];
  try {
    if (browser) { await browser.close().catch(() => undefined); browser = null; }
    if (processHandle?.exitCode === null) { processHandle.kill(); await delay(500); }
    processHandle = null;
    report.cleanup.appStopped = !installed || remainingProcesses() === 0;
    assert(report.cleanup.appStopped, "Installed app remained after cleanup");
  } catch (error) { cleanupErrors.push(error); }
  try { await cleanupTasks(); } catch (error) { cleanupErrors.push(error); }
  try {
    if (installed && await exists(path.join(layout.installDir, "Uninstall SiteIndex.exe"))) {
      command(path.join(layout.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: environment() });
      const until = Date.now() + 10_000;
      while (await exists(exe) && Date.now() < until) await delay(250);
      report.cleanup.uninstalled = !await exists(exe);
      assert(report.cleanup.uninstalled, "NSIS uninstall left installed executable");
    }
  } catch (error) { cleanupErrors.push(error); }
  try {
    report.cleanup.profileRestored = !redirect?.hasChanges || Boolean(redirect.restore());
    assert(report.cleanup.profileRestored, "AppData redirect was not restored");
  } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) { report.result = "failed"; report.failure ??= safe(cleanupErrors[0]); }
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!cleanupErrors.length && report.cleanup.profileRestored)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
}
if (report.result !== "passed") process.exitCode = 1;
