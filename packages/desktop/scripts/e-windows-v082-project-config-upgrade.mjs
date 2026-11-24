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
  [1, "crawl.user_agent", "SiteIndexSynthetic/2.0"],
  [2, "domain", "edited.example.test"],
  [3, "base_url", "https://edited.example.test"],
  [4, "platform", "other"],
  [5, "currency", "EUR"],
  [6, "locale", "en-GB"],
  [7, "timezone", "Europe/London"],
  [8, "markets", ["US", "CA"]],
  [9, "brand.name", "Synthetic Edited Brand"],
  [10, "brand.tagline", "Simple synthetic goods"],
  [11, "brand.voice", "Clear and calm"],
  [12, "brand.audience", "Example shoppers"],
  [13, "brand.usp", ["Clear records", "Quick setup"]],
  [14, "crawl.feed_url", ["https://feed.example.test/products.xml"]],
  [15, "crawl.sku_field", "sku"],
  [16, "crawl.category_depth", 3],
  [17, "crawl.missing_as", "removed"],
  [18, "crawl.max_removed_ratio", 0.3],
  [19, "crawl.feed_generated_at", "2026-11-24T01:00:00Z"],
  [20, "sitemaps", ["https://edited.example.test/sitemap.xml"]],
];
const input = process.argv.slice(2).map((item) => path.resolve(item));
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"Project config acceptance requires a fresh GitHub-hosted Windows runner");
assert(input.length === 2 && process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256,
  "Official baseline and pinned candidate installers are required");
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-config-"));
const layout = createWindowsProfileLayout(root);
const exe = path.join(layout.installDir, "SiteIndex.exe");
const siteFile = path.join(layout.projectRoot, projectId, "index", "site.json");
const reportDir = path.resolve("siteindex-v082-project-config-results");
const report = { result: "pending", stage: "prepare", baselineSha256: null,
  candidateSha256: null, rows: fields.map(([id, key]) => ({ id, key, baselineFile: false,
    baselineApi: false, candidateFile: false, candidateApi: false })), invariants: {}, failure: null };
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
async function stop() {
  if (browser) { await browser.close().catch(() => undefined); browser = null; }
  if (appProcess) { appProcess.kill(); appProcess = null; }
  if (!await exists(exe)) return;
  call("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$expected = [IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_EXE); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'SiteIndex.exe' -and $_.ExecutablePath -ieq $expected } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
  { env: { ...environment(), SITEINDEX_ACCEPTANCE_INSTALL_EXE: exe }, timeout: 20_000 });
  await delay(500);
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
async function compareRows(page, stage, selected) {
  const fromFile = await readConfigFile();
  const fromApi = await apiConfig(page);
  for (const [id, key, expected] of selected) {
    const row = report.rows[id - 1];
    row[`${stage}File`] = JSON.stringify(valueAt(fromFile, key)) === JSON.stringify(expected);
    row[`${stage}Api`] = JSON.stringify(valueAt(fromApi, key)) === JSON.stringify(expected);
    assert(row[`${stage}File`] && row[`${stage}Api`], `#${id} ${key} ${stage} readback mismatch`);
  }
}
async function editJson(page) {
  await page.getByRole("button", { name: "以 JSON 编辑" }).click();
  const editor = page.getByRole("textbox", { name: "项目 JSON" });
  const config = JSON.parse(await editor.inputValue());
  config.crawl.user_agent = fields[0][2];
  await editor.fill(JSON.stringify(config, null, 2));
  await page.getByRole("button", { name: "应用 JSON" }).click();
  await savePage(page, fields[0][1], fields[0][2]);
  return config;
}
async function editBasic(page) {
  const fill = async (label, value) => page.getByLabel(label, { exact: true }).fill(value);
  await fill("域名", fields[1][2]);
  await fill("网站地址", fields[2][2]);
  await page.getByLabel("平台", { exact: true }).selectOption(fields[3][2]);
  await fill("币种", fields[4][2]);
  await fill("语言", fields[5][2]);
  await fill("时区", fields[6][2]);
  await fill("目标市场（逗号分隔）", fields[7][2].join(", "));
  await fill("品牌名", fields[8][2]);
  await fill("一句话定位", fields[9][2]);
  await fill("文案调性", fields[10][2]);
  await fill("目标人群", fields[11][2]);
  await fill("核心卖点（每行一项）", fields[12][2].join("\n"));
  await fill("每行一个地址", fields[13][2][0]);
  await fill("SKU 字段", fields[14][2]);
  await fill("主分类层级", String(fields[15][2]));
  await page.getByLabel("商品消失时", { exact: true }).selectOption(fields[16][2]);
  await fill("移除保护阈值（0–1）", String(fields[17][2]));
  await fill("Feed 生成时间", fields[18][2]);
  await fill("站点地图（每行一个）", fields[19][2][0]);
  await savePage(page, fields[8][1], fields[8][2]);
}
async function main() {
  report.stage = "provenance";
  report.baselineSha256 = await hash(input[0]);
  report.candidateSha256 = await hash(input[1]);
  assert.equal(report.baselineSha256, baselineHash, "Official v0.8.0 EXE SHA256 mismatch");
  assert.equal(report.candidateSha256, process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256.toLowerCase(),
    "Pinned candidate EXE SHA256 mismatch");
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  const checks = await inspectWindowsProfileLayout(layout);
  assert(Object.values(checks).every((item) => item.withinRoot && item.noReparse), "Profile isolation failed");
  redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();
  report.stage = "baseline install";
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
  report.stage = "#1 baseline JSON UI save";
  const jsonExpected = await editJson(page);
  await stop();
  report.invariants.jsonFullConfigFileRoundTrip = containsExpected(await readConfigFile(), jsonExpected);
  assert(report.invariants.jsonFullConfigFileRoundTrip, "JSON editor did not preserve all submitted keys");
  page = await launch();
  report.invariants.jsonFullConfigApiRoundTrip = containsExpected(await apiConfig(page), jsonExpected);
  assert(report.invariants.jsonFullConfigApiRoundTrip, "JSON editor API readback differs");
  await compareRows(page, "baseline", fields.slice(0, 1));
  await projectPage(page);
  report.stage = "#2–20 baseline structured UI save";
  await editBasic(page);
  await stop();
  page = await launch();
  await compareRows(page, "baseline", fields);
  const baselineConfig = await readConfigFile();
  const baselineBytes = await readFile(siteFile);
  await stop();
  report.stage = "pinned candidate overwrite install";
  call(input[1], ["/S", `/D=${layout.installDir}`], { env: environment() });
  assert((await readFile(siteFile)).equals(baselineBytes), "Installer rewrote site.json");
  page = await launch();
  assert.equal(await page.evaluate(() => window.siteindex.app.version()), "0.8.2");
  report.stage = "candidate #1–20 readback";
  await compareRows(page, "candidate", fields);
  report.invariants.fullConfigPreserved = containsExpected(await readConfigFile(), baselineConfig)
    && containsExpected(await apiConfig(page), baselineConfig);
  assert(report.invariants.fullConfigPreserved, "Candidate startup lost a baseline config key");
  await projectPage(page);
  report.stage = "candidate invariants";
  const beforeEmpty = await readFile(siteFile);
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  report.invariants.emptySaveByteIdentical = (await readFile(siteFile)).equals(beforeEmpty);
  assert(report.invariants.emptySaveByteIdentical, "No-op UI save rewrote site.json");
  const oldRevision = (await page.evaluate((id) => window.siteindex.projects.get(id), projectId)).config_revision;
  assert(oldRevision, "Candidate did not expose config revision");
  await page.getByLabel("一句话定位", { exact: true }).fill("");
  await savePage(page, "brand.tagline", "");
  const cleared = await readConfigFile();
  report.invariants.explicitClear = cleared.brand.tagline === "";
  report.invariants.siblingsPreserved = cleared.brand.voice === fields[10][2]
    && cleared.brand.audience === fields[11][2] && cleared.crawl.user_agent === fields[0][2];
  assert(report.invariants.explicitClear && report.invariants.siblingsPreserved,
    "Explicit clear changed another field");
  const beforeStale = await readFile(siteFile);
  const stale = await page.evaluate(async ({ id, revision }) => {
    try {
      await window.siteindex.projects.updateConfig(id, { brand: { voice: "stale write" } },
        { revision, dirty_paths: ["brand.voice"] });
      return "accepted";
    } catch (error) { return String(error?.message ?? error); }
  }, { id: projectId, revision: oldRevision });
  report.invariants.staleRevisionRejected = stale.includes("配置已在别处更新")
    && (await readFile(siteFile)).equals(beforeStale);
  assert(report.invariants.staleRevisionRejected, "Stale revision was not rejected");
  report.result = "passed";
}
try { await main(); }
catch (error) { report.result = "failed"; report.failure = safe(error); }
finally {
  await stop().catch(() => undefined);
  if (installed && await exists(path.join(layout.installDir, "Uninstall SiteIndex.exe"))) {
    try { call(path.join(layout.installDir, "Uninstall SiteIndex.exe"), ["/S"], { env: environment() }); }
    catch (error) { report.result = "failed"; report.failure ??= safe(error); }
  }
  if (redirect?.hasChanges && !redirect.restored && !redirect.restore()) {
    report.result = "failed"; report.failure ??= "Isolated AppData redirect was not restored";
  }
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!redirect?.hasChanges || redirect.restored)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
}
if (report.result !== "passed") process.exitCode = 1;
