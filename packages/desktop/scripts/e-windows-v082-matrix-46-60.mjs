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
const CANDIDATE_SHA = "8dedcea2b0ef30e6d14ec006345a31bfd3b3fdb6f0c42cb876f6263f00ed12e6";
const CASES = [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60];
const JOBS = ["daily", "validate", "weekly", "readme", "monthly"];
const OPTIONS = ["wake_to_run", "run_if_missed", "notify_on_failure", "validate_after_sync"];
const ROOT = process.platform === "win32" && process.env.RUNNER_TEMP
  ? await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-v082-matrix-")) : null;
const LAYOUT = ROOT ? createWindowsProfileLayout(ROOT) : null;
const SETTINGS_PATH = LAYOUT ? path.join(LAYOUT.appDataRoot, "SiteIndex", "settings.json") : "";
const INSTALL_EXE = LAYOUT ? path.join(LAYOUT.installDir, "SiteIndex.exe") : "";
const OUTPUT = path.resolve("siteindex-v082-matrix-46-60-results");
const report = { sourceCommit: null, baseline: { sha256: BASE_SHA }, candidate: { sha256: CANDIDATE_SHA },
  cases: [], result: "pending" };
let browser;
let processHandle;
let redirect;
let currentPage;
let currentCase = null;
let stage = "preflight";

async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function contained(base, file) {
  const check = await inspectContainedPath(base, file);
  assert(check.withinRoot && check.noReparse, "test path escaped isolated runner root");
}
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, ...options });
  assert(!result.error && result.status === 0, `${path.basename(file)} failed: ${result.status ?? "unknown"}`);
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
function environment() {
  const env = windowsProfileEnvironment(LAYOUT, process.env);
  env.SITEINDEX_ACCEPTANCE_PROFILE_ROOT = ROOT;
  env.ELECTRON_RENDERER_URL = "";
  env.SITEINDEX_UI_URL = "";
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
  return env;
}
function disabledSchedule() {
  const job = { enabled: false, days: [], time: "00:00" };
  return { daily: { ...job }, validate: { ...job }, weekly: { ...job }, readme: { ...job },
    monthly: { ...job, day_of_month: 1 }, options: Object.fromEntries(OPTIONS.map((key) => [key, false])) };
}
async function prepare() {
  assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
    && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && ROOT,
  "acceptance requires a fresh GitHub-hosted Windows runner");
  assert(!hasInstalledSiteIndex(), "runner already has SiteIndex installed");
  await contained(process.env.RUNNER_TEMP, ROOT);
  for (const directory of Object.values(LAYOUT)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  redirect = createWindowsAppDataRedirect({ appDataRoot: LAYOUT.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();
  const appData = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { env: environment() });
  assert.equal(appData.toLowerCase(), LAYOUT.appDataRoot.toLowerCase(), "AppData registry redirect failed");
  await writeFile(SETTINGS_PATH, `${JSON.stringify({ device_id: "synthetic-matrix-runner",
    device_name: "Synthetic matrix runner", projects_root: LAYOUT.projectRoot, close_to_tray: false })}\n`);
}
async function makeProject(number) {
  const directory = path.join(LAYOUT.projectRoot, `matrix-${number}`);
  const index = path.join(directory, "index");
  const fixture = makeW2SyntheticFixture("https://fixture.synthetic.invalid");
  const config = fixture.config;
  config.categories = number === 46 ? { mode: "feed", url_pattern: "/shop/{slug}", manual: [] }
    : number === 47 ? { mode: "url_rule", url_pattern: "/shop/{slug}", manual: [] }
      : { mode: "manual", url_pattern: "/shop/{slug}", manual: [{ name: "Base category", slug: "base-category",
        url: "https://fixture.synthetic.invalid/collections/base-category",
        match: [{ type: "url_contains", value: "base-category" }] }] };
  config.schedule = disabledSchedule();
  const files = [
    ["catalog/skus.jsonl", fixture.skus], ["catalog/product_details.jsonl", fixture.productDetails],
    ["inventory/latest.jsonl", fixture.latest], ["views/sku_stock.jsonl", fixture.skuStock],
    ["views/products.jsonl", fixture.products], ["seo/pages.jsonl", fixture.seoPages],
    ["seo/issues.jsonl", fixture.seoIssues], ["seo/links.jsonl", fixture.seoLinks],
    ["content/blog_index.jsonl", fixture.blogs], ["content/keywords.jsonl", []],
    ["ledgers/outreach.jsonl", fixture.outreach], ["ledgers/edm_campaigns.jsonl", []],
    ["logs/runs.jsonl", []],
  ];
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, "site.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(index, ".runner.json"), `${JSON.stringify({ device_id: "synthetic-matrix-runner",
    device_name: "Synthetic matrix runner", claimed_at: "2026-11-24T00:00:00.000Z" })}\n`);
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
  await writeFile(path.join(index, "ledgers", "sku_media.csv"), "sku,image_role,image_url,alt_text,source,width,height,updated_at\n");
  await writeFile(path.join(index, "ledgers", "sku_tags.csv"),
    "sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at\n");
  return { id: `matrix-${number}`, directory, site: path.join(index, "site.json") };
}
async function install(installer) {
  await contained(ROOT, installer);
  run(installer, ["/S", `/D=${LAYOUT.installDir}`], { env: environment(), timeout: 300_000 });
  await contained(ROOT, INSTALL_EXE);
  assert(await exists(path.join(LAYOUT.installDir, "resources", "ui", "index.html")), "installed UI missing");
}
async function uninstall() {
  const target = path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe");
  await contained(ROOT, target);
  run(target, ["/S"], { env: environment() });
  const until = Date.now() + 10_000;
  while (await exists(INSTALL_EXE) && Date.now() < until) await delay(250);
  assert(!await exists(INSTALL_EXE), "isolated NSIS uninstall did not remove installed app");
}
async function launch() {
  const endpoint = "http://127.0.0.1:9348";
  assert(!await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false), "CDP port already in use");
  processHandle = spawn(INSTALL_EXE, ["--remote-debugging-port=9348", "--disable-gpu"],
    { cwd: ROOT, env: environment(), windowsHide: true, stdio: "ignore" });
  processHandle.on("error", () => undefined);
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (processHandle.exitCode !== null) throw new Error("installed app exited before CDP became ready");
    if (await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await delay(300);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
  while (Date.now() < until + 30_000) {
    currentPage = browser.contexts().flatMap((context) => context.pages())
      .find((page) => page.url().startsWith("file:") && page.url().includes("/ui/index.html"));
    if (currentPage) break;
    await delay(200);
  }
  assert(currentPage, "installed UI did not load");
  await currentPage.waitForFunction(() => Boolean(window.siteindex?.projects?.get), null, { timeout: 30_000 });
  return currentPage;
}
async function exitNormally() {
  assert(processHandle && currentPage && browser, "installed UI is unavailable for normal exit");
  await currentPage.evaluate(() => window.close()).catch(() => undefined);
  const until = Date.now() + 30_000;
  while (processHandle.exitCode === null && Date.now() < until) await delay(250);
  assert(processHandle.exitCode !== null, "installed app did not exit after closing its window");
  assert.equal(processHandle.exitCode, 0, "installed app exited with nonzero code after UI close");
  let remaining = 1;
  const childrenUntil = Date.now() + 10_000;
  while (remaining && Date.now() < childrenUntil) {
    remaining = Number(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $expected }).Count"],
    { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: INSTALL_EXE }, timeout: 20_000 }));
    if (remaining) await delay(250);
  }
  assert.equal(remaining, 0, "installed app still has processes at its installation path");
  await browser?.close().catch(() => undefined);
  browser = undefined;
  currentPage = undefined;
  processHandle = undefined;
}
async function route(page, target, label) {
  await page.evaluate((next) => { window.location.hash = `#${next}`; }, target);
  await page.getByText(label, { exact: true }).first().waitFor({ timeout: 30_000 });
}
async function saveThroughUi(page, number, id) {
  if (number <= 51) {
    await route(page, `/p/${id}/settings/categories`, "分类识别方式");
    if (number === 46) await page.locator(".si-category-mode-card").filter({ hasText: "URL 规则" }).first().click();
    if (number === 47) {
      await page.getByRole("button", { name: "+ 添加前缀" }).click();
      await page.getByRole("textbox", { name: "分类 URL 规则 2" }).fill("/gear/{slug}");
    }
    if (number >= 48) {
      await page.locator(".si-category-table-card button:has-text('编辑')").first().click();
      if (number === 48) await page.getByRole("textbox", { name: "分类名称" }).fill("Synthetic renamed category");
      if (number === 49) await page.getByRole("textbox", { name: "Slug" }).fill("renamed-category");
      if (number === 50) await page.getByRole("textbox", { name: "分类页 URL" })
        .fill("https://fixture.synthetic.invalid/collections/renamed-category");
      if (number === 51) await page.getByRole("textbox", { name: "匹配规则值 1" }).fill("renamed-category");
      await page.getByRole("button", { name: "完成编辑" }).click();
    }
    await page.getByRole("button", { name: "保存并重新归类" }).click();
    await page.getByText("分类配置已保存并重新归类。", { exact: true }).waitFor({ timeout: 30_000 });
    return;
  }
  await route(page, `/p/${id}/runs`, "定时计划");
  if (number <= 56) {
    await page.locator(".si-schedule-row").nth(number - 52).getByRole("button", { name: "编辑" }).click();
    await page.getByRole("checkbox", { name: "启用此任务" }).check();
    await page.locator('input[aria-label="执行时间"]').fill(`03:${String(number).padStart(2, "0")}`);
    if (number === 56) await page.getByRole("spinbutton", { name: "每月几号" }).fill("12");
    else await page.getByRole("group", { name: "执行星期" }).getByRole("button", { name: "二" }).click();
    await page.getByRole("button", { name: "保存计划" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 30_000 });
  } else {
    await page.locator(".si-schedule-options-details summary").click();
    await page.getByRole("checkbox", { name: ["到点唤醒电脑执行", "错过后开机尽快补跑",
      "失败时发送系统通知", "每次同步结束后自动校验写入的文件"][number - 57] }).check();
    await page.locator(".si-schedule-options-details").getByRole("button", { name: "保存计划" }).click();
  }
  await page.getByText(/计划已保存/u).first().waitFor({ timeout: 30_000 });
}
function targetValue(number, config) {
  if (number === 46) return config.categories.mode;
  if (number === 47) return config.categories.url_pattern;
  if (number >= 48 && number <= 50) return config.categories.manual?.[0]?.[["name", "slug", "url"][number - 48]];
  if (number === 51) return config.categories.manual?.[0]?.match?.[0];
  if (number <= 56) return config.schedule[JOBS[number - 52]];
  return config.schedule.options[OPTIONS[number - 57]];
}
function expectedValue(number) {
  if (number === 46) return "url_rule";
  if (number === 47) return "/shop/{slug}, /gear/{slug}";
  if (number === 48) return "Synthetic renamed category";
  if (number === 49) return "renamed-category";
  if (number === 50) return "https://fixture.synthetic.invalid/collections/renamed-category";
  if (number === 51) return { type: "url_contains", value: "renamed-category" };
  if (number <= 56) return { enabled: true, days: number === 56 ? [] : [2],
    time: `03:${String(number).padStart(2, "0")}`, ...(number === 56 ? { day_of_month: 12 } : {}) };
  return true;
}
async function readState(page, project, number) {
  return page.evaluate(async ({ id, verify }) => {
    const api = window.siteindex;
    const [detail, category, schedule, tasks, verification] = await Promise.all([
      api.projects.get(id), api.categories.get(id), api.schedule.get(id), api.schedule.listSystemTasks(),
      verify ? api.schedule.verify?.(id) : null,
    ]);
    return { config: detail.config, category, schedule: schedule.config,
      verification: verification?.state ?? null, verificationMessage: verification?.message ?? null,
      tasks: tasks.filter((task) => task.projectId === id).map((task) => task.taskName) };
  }, { id: project.id, verify: number >= 52 && number <= 56 });
}
async function waitForScheduleReady(page, project, number) {
  const name = `\\SiteIndex\\${project.id}-${JOBS[number - 52]}`;
  const until = Date.now() + 60_000;
  let consecutive = 0;
  let last = null;
  while (Date.now() < until) {
    const state = await page.evaluate(async (id) => ({
      verification: await window.siteindex.schedule.verify(id),
      tasks: (await window.siteindex.schedule.listSystemTasks())
        .filter((task) => task.projectId === id).map((task) => task.taskName),
    }), project.id);
    let xmlReadable = false;
    try { xmlReadable = /<Task\b/u.test(run("schtasks.exe", ["/Query", "/TN", name, "/XML"], { timeout: 20_000 })); }
    catch { /* Registration may still be rebuilding the task. */ }
    last = { verification: state.verification.state, message: state.verification.message ?? null,
      taskCount: state.tasks.length, xmlReadable };
    const known52Error = number === 52 && state.verification.state === "error"
      && state.verification.message === "读取计划任务失败：schtasks.exe 执行失败。";
    const ready = (state.verification.state === "ok" || known52Error) && state.tasks.length === 1
      && state.tasks[0].toLowerCase() === name.toLowerCase() && xmlReadable;
    consecutive = ready ? consecutive + 1 : 0;
    if (consecutive >= 2) return last;
    await delay(500);
  }
  throw new Error(`#${number} system task did not stabilize: ${JSON.stringify(last)}`);
}
function checkState(number, state, file, expected) {
  assert.deepEqual(targetValue(number, state.config), expected, `#${number} packaged projects.get value`);
  assert.deepEqual(targetValue(number, file), expected, `#${number} site.json value`);
  if (number <= 51) assert.deepEqual(targetValue(number, { categories: state.category }), expected,
    `#${number} categories.get value`);
  else assert.deepEqual(targetValue(number, { schedule: state.schedule }), expected,
    `#${number} schedule.get value`);
  assert.equal(state.tasks.length, number >= 52 && number <= 56 ? 1 : 0,
    `#${number} Windows task count`);
  if (number === 52) {
    assert(state.verification === "ok" || (state.verification === "error"
      && state.verificationMessage === "读取计划任务失败：schtasks.exe 执行失败。"),
    "#52 schedule.verify returned an unexpected error");
  } else if (number >= 53 && number <= 56) {
    assert.equal(state.verification, "ok", `#${number} schedule.verify state`);
  }
}
function systemTaskNames() {
  const output = run("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"], { timeout: 20_000 });
  return new Set(output.split(/\r?\n/u).map((line) =>
    /^"((?:[^"]|"")*)"/u.exec(line.replace(/^\uFEFF/u, ""))?.[1]?.replaceAll('""', '"').toLowerCase())
    .filter(Boolean));
}
async function cleanupSchedule(page, project, existingNames) {
  const before = await page.evaluate(() => window.siteindex.schedule.listSystemTasks());
  const names = new Set([...existingNames, ...before.filter((task) => task.projectId === project.id)
    .map((task) => task.taskName)].map((name) => name.toLowerCase()));
  await page.evaluate(async (id) => window.siteindex.schedule.save(id, {
    daily: { enabled: false, days: [], time: "00:00" }, validate: { enabled: false, days: [], time: "00:00" },
    weekly: { enabled: false, days: [], time: "00:00" }, readme: { enabled: false, days: [], time: "00:00" },
    monthly: { enabled: false, days: [], time: "00:00", day_of_month: 1 },
    options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false },
  }), project.id);
  const after = await page.evaluate(() => window.siteindex.schedule.listSystemTasks());
  assert(!after.some((task) => task.projectId === project.id || names.has(task.taskName.toLowerCase())),
    `#${project.id} Windows task cleanup failed`);
  const nativeNames = systemTaskNames();
  assert(![...names].some((name) => nativeNames.has(name)), `#${project.id} schtasks still contains a test task`);
}
async function oneCase(number, oldInstaller, candidateInstaller) {
  currentCase = number;
  const project = await makeProject(number);
  const entry = { number, status: "pending", baseline: null, candidate: null, clean: false };
  report.cases.push(entry);
  let knownNames = [];
  try {
    stage = `#${number} baseline install/UI save`;
    await install(oldInstaller);
    let page = await launch();
    assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.0");
    await saveThroughUi(page, number, project.id);
    const oldTask = number >= 52 && number <= 56 ? await waitForScheduleReady(page, project, number) : null;
    const expected = expectedValue(number);
    const oldState = await readState(page, project, number);
    const oldFile = JSON.parse(await readFile(project.site, "utf8"));
    checkState(number, oldState, oldFile, expected);
    knownNames = oldState.tasks;
    entry.baseline = { value: targetValue(number, oldFile), taskCount: knownNames.length,
      fileSha256: await sha256(project.site), ...(number === 52 ? {
        verification: oldState.verification, verificationMessage: oldState.verificationMessage,
        osXmlReadable: oldTask.xmlReadable } : {}) };
    await exitNormally();
    assert.deepEqual(targetValue(number, JSON.parse(await readFile(project.site, "utf8"))), expected,
      `#${number} baseline value changed on normal exit`);
    stage = `#${number} candidate overwrite/readback`;
    await install(candidateInstaller);
    page = await launch();
    assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.2");
    const newTask = number >= 52 && number <= 56 ? await waitForScheduleReady(page, project, number) : null;
    const newState = await readState(page, project, number);
    const newFile = JSON.parse(await readFile(project.site, "utf8"));
    checkState(number, newState, newFile, expected);
    assert.equal(await sha256(project.site), entry.baseline.fileSha256,
      `#${number} site.json bytes changed during candidate overwrite/read`);
    if (knownNames.length) assert.deepEqual(newState.tasks.map((name) => name.toLowerCase()).sort(),
      knownNames.map((name) => name.toLowerCase()).sort(), `#${number} task identity changed`);
    entry.candidate = { value: targetValue(number, newFile), taskCount: newState.tasks.length,
      fileSha256: await sha256(project.site), ...(number === 52 ? {
        verification: newState.verification, verificationMessage: newState.verificationMessage,
        osXmlReadable: newTask.xmlReadable } : {}) };
    await cleanupSchedule(page, project, knownNames);
    entry.clean = true;
    await exitNormally();
    await uninstall();
    entry.status = "passed";
  } finally {
    if (!entry.clean && await exists(INSTALL_EXE)) {
      try {
        const page = currentPage ?? await launch();
        await cleanupSchedule(page, project, knownNames);
        entry.clean = true;
      } catch { entry.cleanupFailure = true; }
    }
    if (currentPage) await exitNormally();
  }
}
async function main() {
  await prepare();
  const [oldInput, newInput] = process.argv.slice(2).map((item) => path.resolve(item));
  assert(await exists(oldInput) && await exists(newInput), "both pinned installers are required");
  assert.equal(await sha256(oldInput), BASE_SHA, "baseline EXE SHA mismatch");
  assert.equal(await sha256(newInput), CANDIDATE_SHA, "candidate EXE SHA mismatch");
  report.sourceCommit = run("git", ["rev-parse", "HEAD"]);
  assert.equal(report.sourceCommit, process.env.SITEINDEX_EXPECTED_SOURCE_COMMIT,
    "acceptance code differs from frozen source commit");
  const oldInstaller = path.join(ROOT, "baseline-setup.exe");
  const candidateInstaller = path.join(ROOT, "candidate-setup.exe");
  await Promise.all([copyFile(oldInput, oldInstaller), copyFile(newInput, candidateInstaller)]);
  for (const number of CASES) await oneCase(number, oldInstaller, candidateInstaller);
  report.result = "passed";
}
let failure;
try { await main(); } catch (error) {
  failure = { case: currentCase, stage, message: String(error?.message ?? error)
    .replaceAll(ROOT ?? "<none>", "<isolated>").replaceAll(process.cwd(), "<checkout>") };
  report.result = "failed";
  console.error(`v0.8.2 matrix #46–60 failed at ${stage}: ${failure.message}`);
} finally {
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill();
    failure ??= { stage: "cleanup", message: "installed app required forced termination" };
  }
  const uninstaller = LAYOUT ? path.join(LAYOUT.installDir, "Uninstall SiteIndex.exe") : "";
  if (uninstaller && await exists(uninstaller)) {
    try { await contained(ROOT, uninstaller); run(uninstaller, ["/S"], { env: environment() }); }
    catch { failure ??= { stage: "cleanup", message: "isolated NSIS uninstall failed" }; }
  }
  if (redirect?.hasChanges && !redirect.restored && !redirect.restore())
    failure ??= { stage: "cleanup", message: "AppData registry restore failed" };
  if (ROOT && (!redirect || redirect.canRemoveProfileRoot)) {
    try { await contained(process.env.RUNNER_TEMP, ROOT); await rm(ROOT, { recursive: true, force: true }); }
    catch { failure ??= { stage: "cleanup", message: "isolated root cleanup failed" }; }
  }
  if (failure) report.result = "failed";
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(path.join(OUTPUT, "summary.json"), `${JSON.stringify({ ...report, failure }, null, 2)}\n`);
  await writeFile(path.join(OUTPUT, "summary.md"), `# v0.8.2 matrix #46–60\n\n${report.cases
    .map((item) => `- #${item.number}: ${item.status}; baseline=${item.baseline?.taskCount ?? "?"} tasks; candidate=${item.candidate?.taskCount ?? "?"} tasks; cleanup=${item.clean}${item.number === 52 ? `; verify=${item.baseline?.verification ?? "?"}/${item.candidate?.verification ?? "?"}; OS XML=${item.baseline?.osXmlReadable ?? "?"}/${item.candidate?.osXmlReadable ?? "?"}` : ""}`)
    .join("\n")}\n\nResult: ${report.result}\n`);
}
if (report.result !== "passed") process.exitCode = 1;
