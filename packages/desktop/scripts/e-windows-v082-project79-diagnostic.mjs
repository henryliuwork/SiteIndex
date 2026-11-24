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

assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"project 79 diagnosis requires a fresh GitHub-hosted Windows runner");
const ROOT = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-project79-"));
const LAYOUT = createWindowsProfileLayout(ROOT);
const OUT = path.resolve("siteindex-project79-diagnostic-results");
const SETTINGS_PATH = path.join(LAYOUT.appDataRoot, "SiteIndex", "settings.json");
const INSTALL_EXE = path.join(LAYOUT.installDir, "SiteIndex.exe");
const PROJECT_PATH = path.join(LAYOUT.projectRoot, "synthetic-project.example.test");
const EXTRA_PATH = path.join(ROOT, "extra-project.example.test");
const CDP_PORT = 9347;
const BASELINE_SHA256 = "65232832171b12d5362c6ec21e6dcb3a542149bbf2e9d1529eacacdf324d7e22";
const CANDIDATE_SHA256 = "8dedcea2b0ef30e6d14ec006345a31bfd3b3fdb6f0c42cb876f6263f00ed12e6";
const report = { purpose: "diagnostic only; G8.2-3 not evaluated", sourceCommit: null,
  installers: { baselineSha256: BASELINE_SHA256, candidateSha256: CANDIDATE_SHA256 },
  baseline: null, candidate: null, settingsUnchangedAfterInstaller: null, cleanup: {}, result: "pending" };
let app;
let browser;
let redirect;
let installed = false;
let stage = "initialization";
const pageEvents = new WeakMap();

const exists = async (file) => access(file).then(() => true, () => false);
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
function redact(value) {
  if (typeof value === "string") return value.replaceAll(ROOT, "<isolated>").replaceAll(process.cwd(), "<checkout>");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  return value;
}
async function contained(root, candidate) {
  const check = await inspectContainedPath(root, candidate);
  assert(check.withinRoot && check.noReparse, "path escaped isolated runner directory");
}
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 300_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} exit ${result.status ?? "unknown"}`);
  return result;
}
function environment() {
  const env = windowsProfileEnvironment(LAYOUT, process.env);
  env.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = ROOT;
  env.ELECTRON_RENDERER_URL = "";
  env.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
  return env;
}
async function prepareProfile() {
  await contained(process.env.RUNNER_TEMP, ROOT);
  for (const dir of Object.values(LAYOUT)) if (typeof dir === "string") await mkdir(dir, { recursive: true });
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const checks = await inspectWindowsProfileLayout(LAYOUT);
  assert(Object.values(checks).every((check) => check.withinRoot && check.noReparse), "profile isolation failed");
  redirect = createWindowsAppDataRedirect({ appDataRoot: LAYOUT.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();
  const probe = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { env: environment() });
  assert.equal(probe.stdout.trim().toLowerCase(), LAYOUT.appDataRoot.toLowerCase());
}
async function makeProjects() {
  const fixture = makeW2SyntheticFixture("https://fixture.synthetic.invalid");
  const index = path.join(PROJECT_PATH, "index");
  const rows = [
    ["catalog/skus.jsonl", fixture.skus.sort((a, b) => a.sku.localeCompare(b.sku))],
    ["catalog/product_details.jsonl", fixture.productDetails],
    ["inventory/latest.jsonl", fixture.latest.sort((a, b) => a.sku.localeCompare(b.sku))],
    ["views/sku_stock.jsonl", fixture.skuStock.sort((a, b) => a.sku.localeCompare(b.sku))],
    ["views/products.jsonl", fixture.products.sort((a, b) => a.handle.localeCompare(b.handle))],
    ["seo/pages.jsonl", fixture.seoPages],
    ["seo/issues.jsonl", fixture.seoIssues], ["seo/links.jsonl", fixture.seoLinks],
    ["content/blog_index.jsonl", fixture.blogs], ["content/keywords.jsonl", []],
    ["ledgers/edm_campaigns.jsonl", []], ["ledgers/outreach.jsonl", fixture.outreach],
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
  await cp(PROJECT_PATH, EXTRA_PATH, { recursive: true });
  const sitePath = path.join(EXTRA_PATH, "index", "site.json");
  const config = JSON.parse(await readFile(sitePath, "utf8"));
  config.domain = "extra.example.test";
  config.base_url = "https://extra.example.test";
  config.brand.name = "Synthetic extra project";
  await writeFile(sitePath, `${JSON.stringify(config, null, 2)}\n`);
}
async function projectDirectoryState() {
  const sitePath = path.join(EXTRA_PATH, "index", "site.json");
  const directory = await stat(EXTRA_PATH).then((value) => value.isDirectory(), () => false);
  const siteFile = await stat(sitePath).then((value) => value.isFile(), () => false);
  let readable = false;
  let brandName = null;
  if (siteFile) {
    try { brandName = JSON.parse(await readFile(sitePath, "utf8")).brand?.name ?? null; readable = true; }
    catch { /* Report unreadable or malformed synthetic site.json without its contents. */ }
  }
  return { directory, siteFile, readable, brandName };
}
async function install(installer) {
  await contained(ROOT, installer);
  run(installer, ["/S", `/D=${LAYOUT.installDir}`], { env: environment() });
  await contained(ROOT, INSTALL_EXE);
  assert(await exists(path.join(LAYOUT.installDir, "resources", "ui", "index.html")));
  installed = true;
}
function cancelFirstRunPicker(pid) {
  const script = `
    Add-Type -Namespace SI -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
    $targetProcessId = ${pid}
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
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 45_000 });
}
async function launch(cancelPicker = false) {
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  assert(!await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false), "CDP port occupied");
  app = spawn(INSTALL_EXE, [`--remote-debugging-port=${CDP_PORT}`, "--disable-gpu"],
    { cwd: ROOT, env: environment(), windowsHide: true, stdio: "ignore" });
  app.on("error", () => undefined);
  if (cancelPicker) cancelFirstRunPicker(app.pid);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error("installed app exited before CDP started");
    if (await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false)) break;
    await delay(500);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
  let page;
  while (Date.now() < deadline + 30_000) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
    if (page) break;
    await delay(300);
  }
  assert(page, "installed UI did not load");
  const events = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") events.consoleErrors.push(redact(message.text()).slice(0, 500));
  });
  page.on("pageerror", (error) => events.pageErrors.push(redact(error.message).slice(0, 500)));
  pageEvents.set(page, events);
  await page.waitForFunction(() => Boolean(window.siteindex?.settings?.get), null, { timeout: 30_000 });
  return page;
}
async function stop() {
  if (!app) return;
  const page = browser?.contexts().flatMap((context) => context.pages())
    .find((item) => item.url().startsWith("file:") && item.url().includes("/ui/index.html"));
  assert(page && !page.isClosed(), "packaged UI unavailable for normal exit");
  await page.evaluate(() => window.close()).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (app.exitCode === null && Date.now() < deadline) await delay(250);
  assert.equal(app.exitCode, 0, "packaged app did not exit normally");
  let remaining = 1;
  const childrenDeadline = Date.now() + 10_000;
  while (remaining && Date.now() < childrenDeadline) {
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $expected }).Count"],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: INSTALL_EXE }, timeout: 20_000 });
    remaining = Number(result.stdout.trim());
    if (remaining) await delay(250);
  }
  assert.equal(remaining, 0, "packaged app still running after UI window.close");
  if (browser) { await browser.close().catch(() => undefined); browser = undefined; }
  app = undefined;
}
async function inspect(label, page) {
  const events = pageEvents.get(page);
  const result = { projectDirectory: await projectDirectoryState(), settingsFile: null,
    settingsIpc: null, ui: { visible: false, titles: [], ...events }, projectsList: null };
  try {
    const disk = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    result.settingsFile = redact({ ok: true, extra_projects: disk.extra_projects,
      projects_root: disk.projects_root });
  } catch (error) {
    result.settingsFile = { ok: false, errorType: error?.name ?? "Error",
      message: redact(String(error?.message ?? error)) };
  }
  const ui = result.ui;
  await page.evaluate(() => { window.location.hash = "#/"; });
  try {
    await page.getByRole("button", { name: "添加已有项目" }).waitFor();
    await page.getByText("Synthetic extra project", { exact: true }).first().waitFor({ timeout: 12_000 });
    ui.visible = true;
  } catch (error) { ui.waitError = error?.name ?? "Error"; }
  await mkdir(OUT, { recursive: true });
  ui.screenshot = `${label}-project-center.png`;
  await page.screenshot({ path: path.join(OUT, ui.screenshot) });
  ui.titles = await page.locator(".si-project-title").allTextContents();
  ui.listText = redact((await page.locator('[aria-label="项目列表"]').allTextContents())
    .map((text) => text.slice(0, 1000)));
  // Capture the UI before this additional read-only IPC call can refresh the project catalog.
  const settings = await page.evaluate(() => window.siteindex.settings.get());
  result.settingsIpc = redact({ extra_projects: settings.extra_projects, projects_root: settings.projects_root });
  const list = await page.evaluate(async () => {
    try { return { ok: true, value: await window.siteindex.projects.list() }; }
    catch (error) { return { ok: false, name: error?.name ?? "Error", code: error?.code ?? null,
      message: String(error?.message ?? error) }; }
  });
  result.projectsList = redact(list);
  return result;
}
async function main() {
  const [oldInput, newInput] = process.argv.slice(2).map((value) => path.resolve(value));
  assert(oldInput && newInput && await exists(oldInput) && await exists(newInput), "two NSIS installers required");
  assert.equal(await sha256(oldInput), BASELINE_SHA256, "official baseline EXE changed");
  assert.equal(await sha256(newInput), CANDIDATE_SHA256, "fixed candidate EXE changed");
  report.sourceCommit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  stage = "isolated profile";
  await prepareProfile();
  await makeProjects();
  const baselineInstaller = path.join(ROOT, "baseline-setup.exe");
  const candidateInstaller = path.join(ROOT, "candidate-setup.exe");
  await Promise.all([copyFile(oldInput, baselineInstaller), copyFile(newInput, candidateInstaller)]);
  stage = "official v0.8.0 setup";
  await install(baselineInstaller);
  await stop();
  const firstPage = await launch(true);
  await firstPage.evaluate((root) => window.siteindex.settings.set(
    { projects_root: root, close_to_tray: false }), LAYOUT.projectRoot);
  await stop();
  stage = "official v0.8.0 project 79 UI";
  const baselinePage = await launch();
  await baselinePage.evaluate(() => { window.location.hash = "#/"; });
  await baselinePage.getByRole("button", { name: "添加已有项目" }).click();
  await baselinePage.locator("#existing-project-path").fill(EXTRA_PATH);
  await baselinePage.getByRole("dialog").getByRole("button", { name: "添加项目", exact: true }).click();
  await baselinePage.waitForFunction(async (expected) =>
    (await window.siteindex.settings.get()).extra_projects.includes(expected), EXTRA_PATH, { timeout: 12_000 });
  report.baseline = await inspect("baseline", baselinePage);
  await stop();
  const beforeInstaller = await readFile(SETTINGS_PATH);
  stage = "fixed v0.8.2 overwrite";
  await install(candidateInstaller);
  await stop();
  report.settingsUnchangedAfterInstaller = (await readFile(SETTINGS_PATH)).equals(beforeInstaller);
  stage = "fixed v0.8.2 project 79 diagnosis";
  const candidatePage = await launch();
  report.candidate = await inspect("candidate", candidatePage);
  await stop();
  report.result = "diagnostic-complete; Gate not evaluated";
}
try { await main(); }
catch (error) {
  report.result = "diagnostic-incomplete";
  report.failure = { stage, type: error?.name ?? "Error", message: redact(String(error?.message ?? error)) };
} finally {
  try { await stop(); report.cleanup.normalExit = true; }
  catch { report.cleanup.normalExit = false; }
  if (!app && installed && await exists(path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe"))) {
    try { run(path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: environment() }); report.cleanup.uninstalled = true; }
    catch { report.cleanup.uninstalled = false; }
  }
  if (redirect?.hasChanges && !redirect.restored) {
    try { report.cleanup.appDataRestored = Boolean(redirect.restore()); }
    catch { report.cleanup.appDataRestored = false; }
  }
  if (!app && (!redirect || redirect.canRemoveProfileRoot)) {
    try { await contained(process.env.RUNNER_TEMP, ROOT); await rm(ROOT, { recursive: true, force: true });
      report.cleanup.profileRemoved = !await exists(ROOT); }
    catch { report.cleanup.profileRemoved = false; }
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(OUT, "summary.md"), [
    "## #79 project-list diagnosis only — G8.2-3 not evaluated",
    `- Result: ${report.result}`,
    `- Official baseline UI / packaged projects.list: ${report.baseline?.ui.visible ?? "unverified"} / ${report.baseline?.projectsList?.ok ?? "unverified"}`,
    `- Fixed candidate UI / packaged projects.list: ${report.candidate?.ui.visible ?? "unverified"} / ${report.candidate?.projectsList?.ok ?? "unverified"}`,
    `- Settings bytes unchanged after overwrite: ${report.settingsUnchangedAfterInstaller ?? "unverified"}`,
    `- Failure stage: ${report.failure?.stage ?? "none"}`,
    "- Source: official v0.8.0 and pinned v0.8.2 NSIS; isolated synthetic projects only.",
  ].join("\n") + "\n");
}
if (report.result === "diagnostic-incomplete" || report.cleanup.normalExit === false
  || report.cleanup.appDataRestored === false || report.cleanup.profileRemoved === false) process.exitCode = 1;
