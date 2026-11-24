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
const projectId = "synthetic-config-project";
const fields = [
  [21, "crawl.overrides", { "SYN-001": { title: "Synthetic override" } }],
  [22, "crawl.rate_limit_ms", 2400],
  [23, "crawl.max_pages", 1200],
  [24, "crawl.crawl_product_pages", false],
  [25, "crawl.auto_collect_products", true],
  [26, "crawl.exclude_url_patterns", ["/synthetic-private/*"]],
  [27, "content.blog_sitemaps", ["https://blog.example.test/post-sitemap.xml"]],
  [28, "content.blog_url_patterns", ["/journal/*"]],
  [29, "sku_grouping.enabled", true],
  [30, "sku_grouping.rule.type", "suffix"],
  [31, "sku_grouping.rule.value", "^(.+?)-[A-Z]{2}$"],
  [32, "categories.watched", [{ name: "Synthetic Category", slug: "synthetic-category", url: "https://config.example.test/category/synthetic-category", manual: true }]],
  [33, "seo.core_keywords", ["synthetic lighting", "example goods"]],
  [34, "seo.competitors", ["competitor.example.test"]],
  [35, "seo.title_range", [32, 62]],
  [36, "seo.description_range", [72, 158]],
  [37, "edm.platform", "other"],
  [38, "edm.max_products", 8],
  [39, "edm.cooldown_days", 14],
  [40, "edm.utm.source", "synthetic_newsletter"],
  [41, "edm.utm.medium", "example_email"],
  [42, "edm.image_priority", ["manual", "feed"]],
  [43, "integrations.mailchimp.audience", "synthetic-audience"],
  [44, "integrations.linkflow.mcp_server", "synthetic-mcp"],
  [45, "integrations.linkflow.create_tool", "synthetic-create"],
];
const input = process.argv.slice(2).map((item) => path.resolve(item));
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"Project config acceptance requires a fresh GitHub-hosted Windows runner");
assert(input.length === 2 && process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256,
  "Official baseline and pinned candidate installers are required");
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-config-"));
let layout; let exe; let siteFile;
const reportDir = path.resolve("siteindex-v082-project-config-advanced-results");
const report = { result: "pending", stage: "prepare", baselineSha256: null,
  candidateSha256: null, rows: fields.map(([id, key]) => ({ id, key, uiSaved: false,
    baselineExitMode: null, baselineFile: false, baselineApi: false, candidateInstalled: false,
    installerByteIdentical: false, candidateFile: false, candidateApi: false,
    fullConfigPreserved: false, emptySaveByteIdentical: false,
    candidateExitMode: null, outcome: "unverified" })), failure: null };
let redirect; let installed = false; let appProcess; let browser;

const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const readConfigFile = async () => JSON.parse(await readFile(siteFile, "utf8"));
const valueAt = (source, key) => key.split(".").reduce((value, part) => value?.[part], source);
function containsExpected(actual, expected) {
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  if (expected && typeof expected === "object")
    return actual && typeof actual === "object" && Object.entries(expected)
      .every(([key, value]) => containsExpected(actual[key], value));
  return JSON.stringify(actual) === JSON.stringify(expected);
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
async function apiConfig(page) {
  const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
  return project.config;
}
async function projectPage(page) {
  await page.evaluate((id) => { window.location.hash = `#/p/${id}/settings/config`; }, projectId);
  await page.getByRole("button", { name: "保存配置", exact: true }).waitFor();
}
async function savePage(page, key, expected) {
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.waitForFunction(async ({ id, pathKey, value }) => {
    const project = await window.siteindex.projects.get(id);
    const actual = pathKey.split(".").reduce((item, segment) => item?.[segment], project.config);
    return JSON.stringify(actual) === JSON.stringify(value);
  }, { id: projectId, pathKey: key, value: expected }, { timeout: 20_000 });
}
async function compareRow(page, stage, index) {
  const fromFile = await readConfigFile();
  const fromApi = await apiConfig(page);
  const [id, key, expected] = fields[index];
  const row = report.rows[index];
  row[`${stage}File`] = JSON.stringify(valueAt(fromFile, key)) === JSON.stringify(expected);
  row[`${stage}Api`] = JSON.stringify(valueAt(fromApi, key)) === JSON.stringify(expected);
  assert(row[`${stage}File`] && row[`${stage}Api`], `#${id} ${key} ${stage} readback mismatch`);
}
const actions = [
  ["source", "数据修正（overrides，JSON 对象）", "textarea", (v) => JSON.stringify(v)],
  ["crawl", "请求间隔（毫秒）", "input"],
  ["crawl", "每周最多页面", "input"],
  ["crawl", "每周抓取产品页 SEO", "checkbox"],
  ["crawl", "无 Feed 时自动采集商品", "checkbox"],
  ["crawl", "排除 URL 规则（每行一条）", "textarea", (v) => v.join("\n")],
  ["blog-recognition", "博客 Sitemap（每行一个地址）", "textarea", (v) => v.join("\n")],
  ["blog-recognition", "博客 URL 前缀或规则（每行一条）", "textarea", (v) => v.join("\n")],
  ["sku-grouping", "启用父子 SKU 分组", "checkbox"],
  ["sku-grouping", "分组规则类型", "select", () => "suffix"],
  ["sku-grouping", "规则值", "input"],
  ["watched-categories", "手动添加分类", "category"],
  ["seo", "核心关键词（每行一项）", "textarea", (v) => v.join("\n")],
  ["seo", "竞品域名（每行一个）", "textarea", (v) => v.join("\n")],
  ["seo", "Title 长度范围", "range", () => ["Title 最短长度", "Title 最长长度"]],
  ["seo", "Description 长度范围", "range", () => ["Description 最短长度", "Description 最长长度"]],
  ["edm", "邮件平台", "select"],
  ["edm", "每封产品数", "input"],
  ["edm", "推荐冷却期（天）", "input"],
  ["edm", "UTM source", "input"],
  ["edm", "UTM medium", "input"],
  ["edm", "图片优先级", "select", (v) => v.join(",")],
  ["edm", "默认受众", "input"],
  ["integrations", "LinkFlow MCP 服务", "input"],
  ["integrations", "录入工具", "input"],
];
function labeledControl(page, section, label, element) {
  return page.locator(`#${section} label.si-config-field`).filter({
    has: page.getByText(label, { exact: true }),
  }).locator(element);
}
async function editField(page, index) {
  const [id, key, expected] = fields[index];
  const [section, label, kind, encode = String] = actions[index];
  if (kind === "category") {
    const form = page.locator(`#${section} .si-config-manual-watched`);
    for (const [name, value] of [["分类名称", expected[0].name], ["Slug", expected[0].slug], ["分类 URL", expected[0].url]])
      await form.locator("label.si-config-field").filter({ has: page.getByText(name, { exact: true }) }).locator("input").fill(value);
    await form.getByRole("button", { name: "添加关注分类" }).click();
  } else if (kind === "range") {
    const labels = encode(expected);
    for (let position = 0; position < 2; position++)
      await page.locator(`#${section} input[aria-label="${labels[position]}"]`).fill(String(expected[position]));
  } else if (kind === "checkbox") {
    const control = id === 25 ? page.locator("#si-auto-collect-products")
      : page.locator(`#${section} label`).filter({ hasText: label }).locator("input[type=checkbox]");
    if (await control.isChecked() !== expected) await control.click();
  } else {
    const control = labeledControl(page, section, label, kind);
    if (kind === "select") await control.selectOption(encode(expected));
    else await control.fill(encode(expected));
  }
  await savePage(page, key, expected);
  report.rows[index].uiSaved = true;
}
async function checkField(index) {
  const [id, key, expected] = fields[index];
  const row = report.rows[index];
  layout = createWindowsProfileLayout(path.join(root, `field-${id}`));
  exe = path.join(layout.installDir, "SiteIndex.exe");
  siteFile = path.join(layout.projectRoot, projectId, "_site-index", "site.json");
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
  await projectPage(page);
  report.stage = `#${id} baseline UI save`;
  await editField(page, index);
  row.baselineExitMode = await stop(true);
  report.stage = `#${id} exited baseline file readback`;
  const savedFile = await readConfigFile();
  row.baselineFile = JSON.stringify(valueAt(savedFile, key)) === JSON.stringify(expected);
  assert(row.baselineFile, `#${id} exited baseline file mismatch`);
  page = await launch();
  report.stage = `#${id} new baseline process API readback`;
  await compareRow(page, "baseline", index);
  const baselineConfig = await readConfigFile();
  const baselineBytes = await readFile(siteFile);
  await stop(true);
  report.stage = `#${id} pinned candidate overwrite install`;
  call(input[1], ["/S", `/D=${layout.installDir}`], { env: environment() });
  row.candidateInstalled = true;
  row.installerByteIdentical = (await readFile(siteFile)).equals(baselineBytes);
  assert(row.installerByteIdentical, `#${id} installer rewrote site.json`);
  page = await launch();
  assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.2");
  report.stage = `#${id} candidate file and API readback`;
  await compareRow(page, "candidate", index);
  row.fullConfigPreserved = containsExpected(await readConfigFile(), baselineConfig)
    && containsExpected(await apiConfig(page), baselineConfig);
  assert(row.fullConfigPreserved, `#${id} candidate startup lost a baseline config key`);
  await projectPage(page);
  report.stage = `#${id} candidate no-op save`;
  const beforeEmpty = await readFile(siteFile);
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  row.emptySaveByteIdentical = (await readFile(siteFile)).equals(beforeEmpty);
  assert(row.emptySaveByteIdentical, `#${id} no-op UI save rewrote site.json`);
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
