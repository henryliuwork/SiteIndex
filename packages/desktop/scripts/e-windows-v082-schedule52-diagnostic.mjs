import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeW2SyntheticFixture } from "./e-windows-v040-synthetic-fixture.mjs";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectContainedPath, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const BASE_SHA = "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22";
const JOBS = ["daily", "validate", "weekly", "readme", "monthly"];
const PROJECT_ID = "matrix-52";
const ROOT = process.platform === "win32" && process.env.RUNNER_TEMP
  && process.env.GITHUB_ACTIONS === "true" && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted"
  ? await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-schedule52-diag-")) : null;
const LAYOUT = ROOT ? createWindowsProfileLayout(ROOT) : null;
const INSTALL_EXE = LAYOUT ? path.join(LAYOUT.installDir, "SiteIndex.exe") : "";
const PROJECT = LAYOUT ? path.join(LAYOUT.projectRoot, PROJECT_ID) : "";
const RESULT_DIR = path.resolve("siteindex-v082-schedule52-diagnostic-results");
const report = { kind: "diagnostic-only", result: "pending", stage: "preflight", sourceCommit: null,
  baselineSha256: BASE_SHA, saveReturn: "unobservable through packaged UI bridge",
  identity: null, before: null, saveToast: null, after: null, runnerComparison: null, ipc: null,
  cleanupDeletes: [], cleanupSnapshot: null,
  cleanup: { tasksAbsent: false, appStopped: false, uninstalled: false, profileRestored: false },
  failure: null };
let redirect;
let app;
let browser;
let page;
let syntheticOwned = false;

const names = JOBS.flatMap((job) => [`\\SiteIndex\\${PROJECT_ID}-${job}`, `SiteIndex - ${PROJECT_ID}-${job}`]);
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function contained(file) {
  const check = await inspectContainedPath(ROOT, file);
  assert(check.withinRoot && check.noReparse, "synthetic path escaped runner root");
}
function environment() {
  const env = windowsProfileEnvironment(LAYOUT, process.env);
  env.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = ROOT;
  env.ELECTRON_RENDERER_URL = "";
  env.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
  return env;
}
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, ...options });
  assert(!result.error && result.status === 0, `${path.basename(file)} exit ${result.status ?? "unknown"}`);
  return result.stdout.trim();
}
function hasInstalledSiteIndex() {
  const roots = ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"];
  return roots.some((root) => {
    const result = spawnSync("reg.exe", ["query", root, "/s"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 && result.stdout.split(/(?=HKEY_)/u).some((entry) =>
      /^\s*DisplayName\s+REG_\w+\s+SiteIndex(?:\s+\d+(?:\.\d+)*)?\s*$/imu.test(entry));
  });
}
function sanitized(value) {
  return String(value ?? "").replaceAll(ROOT ?? "<none>", "<synthetic-root>")
    .replaceAll(process.cwd(), "<checkout>");
}
function query(name, executionContext = "isolated-profile") {
  const argv = ["/Query", "/TN", name, "/XML"];
  const result = spawnSync("schtasks.exe", argv, { encoding: "buffer", windowsHide: true, timeout: 20_000,
    env: executionContext === "isolated-profile" ? environment() : process.env });
  const stdout = Buffer.from(result.stdout ?? []);
  const stderr = Buffer.from(result.stderr ?? []);
  return { command: "schtasks.exe", argv, executionContext, exitCode: result.status, signal: result.signal,
    spawnError: result.error ? sanitized(result.error.message) : null,
    stderrUtf8: sanitized(stderr.toString("utf8")), stderrBytesBase64: stderr.toString("base64"),
    stdoutOnFailureUtf8: result.status === 0 ? null : sanitized(stdout.toString("utf8")),
    stdoutOnFailureBytesBase64: result.status === 0 ? null : stdout.toString("base64"),
    xmlReadable: result.status === 0 && stdout.length > 0 };
}
function snapshot(label) {
  const taskQueries = names.map((name) => query(name));
  const argv = ["/Query", "/FO", "CSV", "/NH"];
  const list = spawnSync("schtasks.exe", argv, { encoding: "buffer", windowsHide: true, timeout: 20_000,
    env: environment() });
  const listText = Buffer.from(list.stdout ?? []).toString("utf8");
  const matches = listText.split(/\r?\n/u).filter((line) => line.toLowerCase().includes(PROJECT_ID));
  return { label, taskQueries, list: { command: "schtasks.exe", argv, exitCode: list.status,
    spawnError: list.error ? sanitized(list.error.message) : null,
    stderrUtf8: sanitized(Buffer.from(list.stderr ?? []).toString("utf8")),
    stderrBytesBase64: Buffer.from(list.stderr ?? []).toString("base64"),
    syntheticMatches: matches.map(sanitized) },
  conflictNames: taskQueries.filter((item) => item.exitCode === 0).map((item) => item.argv[2]) };
}
function disabledSchedule() {
  const job = { enabled: false, days: [], time: "00:00" };
  return { daily: { ...job }, validate: { ...job }, weekly: { ...job }, readme: { ...job },
    monthly: { ...job, day_of_month: 1 }, options: {
      wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } };
}
async function makeProject() {
  const fixture = makeW2SyntheticFixture("https://fixture.synthetic.invalid");
  fixture.config.schedule = disabledSchedule();
  const index = path.join(PROJECT, "index");
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, "site.json"), `${JSON.stringify(fixture.config, null, 2)}\n`);
  await writeFile(path.join(index, ".runner.json"), `${JSON.stringify({ device_id: "synthetic-matrix-runner",
    device_name: "Synthetic matrix runner", claimed_at: "2026-11-24T00:00:00.000Z" })}\n`);
  const files = [
    ["catalog/skus.jsonl", fixture.skus], ["catalog/product_details.jsonl", fixture.productDetails],
    ["inventory/latest.jsonl", fixture.latest], ["views/sku_stock.jsonl", fixture.skuStock],
    ["views/products.jsonl", fixture.products], ["seo/pages.jsonl", fixture.seoPages],
    ["seo/issues.jsonl", fixture.seoIssues], ["seo/links.jsonl", fixture.seoLinks],
    ["content/blog_index.jsonl", fixture.blogs], ["content/keywords.jsonl", []],
    ["ledgers/outreach.jsonl", fixture.outreach], ["ledgers/edm_campaigns.jsonl", []],
    ["logs/runs.jsonl", []],
  ];
  for (const [name, rows] of files) {
    const target = path.join(index, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  }
  await writeFile(path.join(index, "catalog", "categories.json"), `${JSON.stringify(fixture.categories, null, 2)}\n`);
  for (const month of ["2026-10", "2026-11"]) {
    const target = path.join(index, "inventory", "events", `${month}.jsonl`);
    const rows = fixture.events.filter((event) => event.date.startsWith(month));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  const daily = fixture.dailySummaryRows.map((row) =>
    [row.date, row.category, row.total, row.in_stock, row.out_of_stock, row.preorder, row.unknown].join(","));
  await writeFile(path.join(index, "inventory", "daily_summary.csv"),
    `date,category,total,in_stock,out_of_stock,preorder,unknown\n${daily.join("\n")}\n`);
  await writeFile(path.join(index, "ledgers", "sku_media.csv"),
    "sku,image_role,image_url,alt_text,source,width,height,updated_at\n");
  await writeFile(path.join(index, "ledgers", "sku_tags.csv"),
    "sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at\n");
}
async function prepare() {
  assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
    && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && ROOT,
  "diagnostic requires a fresh GitHub-hosted Windows runner");
  assert(!hasInstalledSiteIndex(), "runner already has SiteIndex installed");
  const rootCheck = await inspectContainedPath(process.env.RUNNER_TEMP, ROOT);
  assert(rootCheck.withinRoot && rootCheck.noReparse, "synthetic root escaped runner temp");
  for (const directory of Object.values(LAYOUT)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  await mkdir(path.join(LAYOUT.appDataRoot, "SiteIndex"), { recursive: true });
  redirect = createWindowsAppDataRedirect({ appDataRoot: LAYOUT.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();
  const appData = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { env: environment() });
  assert.equal(appData.toLowerCase(), LAYOUT.appDataRoot.toLowerCase(), "AppData redirect failed");
  await writeFile(path.join(LAYOUT.appDataRoot, "SiteIndex", "settings.json"),
    `${JSON.stringify({ device_id: "synthetic-matrix-runner", device_name: "Synthetic matrix runner",
      projects_root: LAYOUT.projectRoot, close_to_tray: false })}\n`);
  await makeProject();
}
async function launch() {
  const endpoint = "http://127.0.0.1:9592";
  assert(!await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false), "CDP port occupied");
  app = spawn(INSTALL_EXE, ["--remote-debugging-port=9592", "--disable-gpu"],
    { cwd: ROOT, env: environment(), windowsHide: true, stdio: "ignore" });
  app.on("error", () => undefined);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) {
    if (app.exitCode !== null) throw new Error("installed app exited before CDP became ready");
    await delay(300);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
  while (Date.now() < deadline + 30_000 && !page) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (!page) await delay(200);
  }
  assert(page, "installed UI did not load");
  await page.waitForFunction(() => Boolean(window.siteindex?.schedule?.verify), null, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.0");
}
async function saveThroughUi() {
  await page.evaluate((id) => { window.location.hash = `#/p/${id}/runs`; }, PROJECT_ID);
  await page.getByText("定时计划", { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.locator(".si-schedule-row").first().getByRole("button", { name: "编辑" }).click();
  await page.getByRole("checkbox", { name: "启用此任务" }).check();
  await page.locator('input[aria-label="执行时间"]').fill("03:52");
  await page.getByRole("group", { name: "执行星期" }).getByRole("button", { name: "二" }).click();
  await page.getByRole("button", { name: "保存计划" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 30_000 });
  const toast = page.getByText(/计划已保存/u).first();
  await toast.waitFor({ timeout: 30_000 });
  report.saveToast = await toast.innerText();
}
async function readPackagedState() {
  return page.evaluate(async (id) => {
    const api = window.siteindex;
    const verification = await api.schedule.verify(id);
    const [schedule, status, tasks] = await Promise.all([
      api.schedule.get(id), api.schedule.status(), api.schedule.listSystemTasks()]);
    return { verification, schedule: { config: schedule.config, registered: schedule.registered }, status,
      tasks: tasks.filter((item) => item.projectId === id).map((item) => item.taskName) };
  }, PROJECT_ID);
}
async function cleanupTasks() {
  if (!syntheticOwned) return;
  if (page && !page.isClosed()) {
    try { await page.evaluate(async ({ id, config }) => window.siteindex.schedule.save(id, config),
      { id: PROJECT_ID, config: disabledSchedule() }); } catch { /* Native cleanup below remains mandatory. */ }
  }
  for (const name of names) {
    const before = query(name);
    if (before.exitCode !== 0) continue;
    const argv = ["/Delete", "/TN", name, "/F"];
    const result = spawnSync("schtasks.exe", argv,
      { encoding: "buffer", windowsHide: true, timeout: 20_000 });
    report.cleanupDeletes.push({ command: "schtasks.exe", argv, exitCode: result.status,
      stderrUtf8: sanitized(Buffer.from(result.stderr ?? []).toString("utf8")),
      stderrBytesBase64: Buffer.from(result.stderr ?? []).toString("base64") });
  }
  report.cleanupSnapshot = snapshot("cleanup");
  const after = report.cleanupSnapshot;
  report.cleanup.tasksAbsent = after.taskQueries.every((item) => item.exitCode !== 0 && !item.spawnError)
    && report.cleanupDeletes.every((item) => item.exitCode === 0)
    && after.conflictNames.length === 0 && after.list.exitCode === 0 && after.list.syntheticMatches.length === 0;
  assert(report.cleanup.tasksAbsent, "synthetic task remained after cleanup");
}
async function closeApp() {
  if (!app) { report.cleanup.appStopped = true; return; }
  if (page && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (app.exitCode === null && Date.now() < deadline) await delay(250);
  if (app.exitCode === null) { app.kill(); throw new Error("installed app required forced termination"); }
  assert.equal(app.exitCode, 0, "installed app exited with nonzero code");
  const childDeadline = Date.now() + 10_000;
  let remaining = 1;
  while (remaining && Date.now() < childDeadline) {
    remaining = Number(command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $expected }).Count"],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: INSTALL_EXE }, timeout: 20_000 }));
    if (remaining) await delay(250);
  }
  assert.equal(remaining, 0, "installed app left same-path processes");
  await browser?.close().catch(() => undefined);
  report.cleanup.appStopped = true;
}
async function main() {
  await prepare();
  const installer = path.resolve(process.argv[2] ?? "");
  assert(await exists(installer) && await sha256(installer) === BASE_SHA, "official baseline EXE SHA mismatch");
  report.sourceCommit = command("git", ["rev-parse", "HEAD"]);
  assert.equal(report.sourceCommit, process.env.SITEINDEX_EXPECTED_SOURCE_COMMIT, "diagnostic source commit mismatch");
  report.stage = "baseline install";
  const isolatedInstaller = path.join(ROOT, "baseline-setup.exe");
  await copyFile(installer, isolatedInstaller);
  await contained(isolatedInstaller);
  assert.equal(await sha256(isolatedInstaller), BASE_SHA, "isolated baseline copy SHA mismatch");
  command(isolatedInstaller, ["/S", `/D=${LAYOUT.installDir}`], { env: environment(), timeout: 300_000 });
  await contained(INSTALL_EXE);
  await launch();
  const whoami = command("whoami.exe", []);
  const admin = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"],
  { env: environment() });
  report.identity = { admin: admin.trim().toLowerCase() === "true",
    usernameHasSpace: /\s/u.test(whoami), usernameHasChinese: /[\u3400-\u9fff]/u.test(whoami),
    projectPathHasSpace: /\s/u.test(PROJECT), projectPathHasChinese: /[\u3400-\u9fff]/u.test(PROJECT),
    installPathHasSpace: /\s/u.test(INSTALL_EXE), installPathHasChinese: /[\u3400-\u9fff]/u.test(INSTALL_EXE),
    codePage: command("cmd.exe", ["/d", "/c", "chcp"]) };
  report.stage = "before UI save";
  report.before = snapshot("before UI save");
  assert.equal(report.before.list.exitCode, 0, "pre-save system task list failed");
  assert.deepEqual(report.before.conflictNames, [], "synthetic task name conflict before save");
  assert.deepEqual(report.before.list.syntheticMatches, [], "synthetic task name in global list before save");
  syntheticOwned = true;
  report.stage = "UI save and packaged verify";
  await saveThroughUi();
  report.ipc = await readPackagedState();
  report.after = snapshot("after UI save");
  report.runnerComparison = [names[0], names[2]].map((name) => query(name, "runner-default"));
  report.result = "diagnostic-complete-not-gate-acceptance";
}
try { await main(); } catch (error) {
  report.failure = { stage: report.stage, message: sanitized(error?.message ?? error) };
  report.result = "diagnostic-incomplete";
} finally {
  try { await cleanupTasks(); } catch (error) {
    report.failure ??= { stage: "task cleanup", message: sanitized(error?.message ?? error) };
    report.result = "diagnostic-incomplete";
  }
  try { await closeApp(); } catch (error) {
    report.failure ??= { stage: "app exit", message: sanitized(error?.message ?? error) };
    report.result = "diagnostic-incomplete";
  }
  const uninstaller = LAYOUT ? path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe") : "";
  if (uninstaller && await exists(uninstaller)) {
    try { await contained(uninstaller); command(uninstaller, ["/S"], { env: environment() });
      const until = Date.now() + 10_000;
      while (await exists(INSTALL_EXE) && Date.now() < until) await delay(250);
      report.cleanup.uninstalled = !await exists(INSTALL_EXE); }
    catch (error) { report.failure ??= { stage: "uninstall", message: sanitized(error?.message ?? error) }; }
  } else report.cleanup.uninstalled = !await exists(INSTALL_EXE);
  if (redirect?.hasChanges) report.cleanup.profileRestored = redirect.restore();
  else report.cleanup.profileRestored = true;
  if (ROOT && redirect?.canRemoveProfileRoot) {
    try {
      const rootCheck = await inspectContainedPath(process.env.RUNNER_TEMP, ROOT);
      assert(rootCheck.withinRoot && rootCheck.noReparse, "synthetic root escaped runner temp");
      await rm(ROOT, { recursive: true, force: true });
    }
    catch (error) { report.failure ??= { stage: "profile cleanup", message: sanitized(error?.message ?? error) }; }
  }
  if (!Object.values(report.cleanup).every(Boolean)) {
    report.failure ??= { stage: "cleanup", message: "isolated task, process, uninstall, or profile cleanup incomplete" };
  }
  if (report.failure) report.result = "diagnostic-incomplete";
  await mkdir(RESULT_DIR, { recursive: true });
  await writeFile(path.join(RESULT_DIR, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Schedule #52 diagnostic result: ${report.result}; verify=${report.ipc?.verification?.state ?? "unobserved"}`);
  if (report.failure) process.exitCode = 1;
}
