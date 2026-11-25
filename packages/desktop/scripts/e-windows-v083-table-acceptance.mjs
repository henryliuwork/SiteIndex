import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeW2SyntheticFixture } from "./e-windows-v040-synthetic-fixture.mjs";
import { createWindowsAppDataRedirect } from "./windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, inspectWindowsProfileLayout, windowsProfileEnvironment } from "./e-windows-profile-isolation.mjs";

const expectedHash = process.env.SITEINDEX_ACCEPTANCE_INSTALLER_SHA256
  ?? "94f689e66e5fecbda62eb7dcb631df5412549420e56249ce88f1ab26dbb20100";
const expectedVersion = process.env.SITEINDEX_ACCEPTANCE_VERSION ?? "0.8.3";
const expectedHelpSize = Number(process.env.SITEINDEX_ACCEPTANCE_HELP_SIZE ?? "18");
const projectId = "synthetic-v083-products";
const tableId = "products.merged";
const oldColumns = ["stock_status", "online_rate_30d", "price", "actions"];
const installer = path.resolve(process.argv[2] ?? "");
const reportDir = path.resolve(process.env.SITEINDEX_ACCEPTANCE_REPORT_DIR
  ?? process.env.SITEINDEX_V083_REPORT_DIR ?? "v083-table-results");
assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_TEMP,
"Packaged installation acceptance requires a fresh hosted Windows runner");
assert(path.basename(installer) === `SiteIndex-Setup-${expectedVersion}.exe`, "The expected installer version is required");
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "siteindex-v083-"));
const layout = createWindowsProfileLayout(root);
const projectDir = path.join(layout.projectRoot, projectId);
const exe = path.join(layout.installDir, "SiteIndex.exe");
const report = { sourceRun: 45540953781, sourceCommit: "1bf5ee8bc77918ca2b670a28bc89556a7b7de439",
  installerSha256: null, evidence: "packaged Electron on hosted Windows; DPR via CDP emulation",
  checks: [], outcome: "pending", stage: "prepare" };
let redirect; let processHandle; let browser; let page;

const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const jsonl = async (file, rows) => { await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "")); };
const env = () => {
  const result = { ...windowsProfileEnvironment(layout, process.env), ELECTRON_RENDERER_URL: "", SITEINDEX_UI_URL: "" };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete result[key];
  return result;
};
function call(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 300_000, windowsHide: true, ...options });
  assert(!result.error && result.status === 0, `${path.basename(file)} exited ${result.status ?? "unknown"}`);
}
async function makeProject() {
  const fixture = makeW2SyntheticFixture("https://v083.example.test");
  const index = path.join(projectDir, "index");
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, "site.json"), JSON.stringify(fixture.config, null, 2) + "\n");
  await jsonl(path.join(index, "catalog/skus.jsonl"), fixture.skus);
  await jsonl(path.join(index, "catalog/product_details.jsonl"), fixture.productDetails);
  await jsonl(path.join(index, "inventory/latest.jsonl"), fixture.latest);
  await jsonl(path.join(index, "views/sku_stock.jsonl"), fixture.skuStock);
  await jsonl(path.join(index, "views/products.jsonl"), fixture.products);
  await jsonl(path.join(index, "seo/pages.jsonl"), fixture.seoPages);
  await jsonl(path.join(index, "seo/issues.jsonl"), fixture.seoIssues);
  await jsonl(path.join(index, "seo/links.jsonl"), fixture.seoLinks);
  await jsonl(path.join(index, "content/blog_index.jsonl"), fixture.blogs);
  await jsonl(path.join(index, "content/keywords.jsonl"), []);
  await jsonl(path.join(index, "ledgers/edm_campaigns.jsonl"), []);
  await jsonl(path.join(index, "ledgers/outreach.jsonl"), fixture.outreach);
  await jsonl(path.join(index, "logs/runs.jsonl"), []);
  for (const month of ["2026-10", "2026-11"]) {
    await jsonl(path.join(index, "inventory/events", `${month}.jsonl`), fixture.events.filter((row) => row.date.startsWith(month)));
  }
  const summaryLines = fixture.dailySummaryRows.map((row) =>
    [row.date, row.category, row.total, row.in_stock, row.out_of_stock, row.preorder, row.unknown].join(","));
  await writeFile(path.join(index, "inventory/daily_summary.csv"),
    "date,category,total,in_stock,out_of_stock,preorder,unknown\n" + summaryLines.join("\n") + "\n");
  await writeFile(path.join(index, "catalog/categories.json"), JSON.stringify(fixture.categories, null, 2) + "\n");
  await writeFile(path.join(index, "ledgers/sku_media.csv"), "sku,image_role,image_url,alt_text,source,width,height,updated_at\n");
  await writeFile(path.join(index, "ledgers/sku_tags.csv"), "sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at\n");
}
async function launch() {
  const endpoint = "http://127.0.0.1:9563";
  assert(!await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false), "CDP port is occupied");
  processHandle = spawn(exe, ["--remote-debugging-port=9563", "--disable-gpu", "--siteindex-hosted-acceptance"],
    { cwd: root, env: env(), windowsHide: true, stdio: "ignore" });
  processHandle.on("error", () => undefined);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false)) {
    assert(processHandle.exitCode === null, "Packaged app exited before CDP was ready");
    await delay(300);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  while (Date.now() < deadline + 30_000 && !page) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:") && candidate.url().includes("/ui/index.html"));
    if (!page) await delay(300);
  }
  assert(page, "Packaged UI did not open");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => Boolean(window.siteindex?.projects?.addExisting));
  const settings = await page.evaluate(() => window.siteindex.settings.get());
  if (settings.close_to_tray) await page.evaluate(() => window.siteindex.settings.set({ close_to_tray: false }));
  return page;
}
async function stop() {
  if (page && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (processHandle?.exitCode === null && Date.now() < deadline) await delay(250);
  assert.equal(processHandle?.exitCode, 0, "Packaged app did not exit normally");
  await browser?.close().catch(() => undefined);
  browser = null; page = null; processHandle = null;
}
const headers = async () => page.locator(`[aria-label="${tableId} 数据表"] thead th`)
  .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".si-sort-button")?.textContent?.trim() || node.textContent?.trim()).filter(Boolean));
async function openProducts() {
  await page.evaluate((id) => { window.location.hash = `#/p/${id}/products`; }, projectId);
  await page.locator(`[aria-label="${tableId} 数据表"] tbody tr[data-row-id]`).first().waitFor({ timeout: 30_000 });
}
async function dragPriceBeforeStock() {
  await page.getByRole("button", { name: "列设置" }).click();
  const menu = page.locator(".si-column-popover");
  await menu.locator('[role="img"][aria-label="拖动 价格"]').dragTo(
    menu.locator(".si-column-menu-row").filter({ hasText: "库存状态" }));
}
async function inspect(scale) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: scale, mobile: false });
  const result = await page.locator(`[aria-label="${tableId} 数据表"]`).evaluate((table) => {
    const heads = [...table.querySelectorAll("thead th")];
    const firstRow = [...table.querySelectorAll("tbody tr[data-row-id] td")];
    const label = (th) => th.querySelector(".si-sort-button")?.textContent?.trim() || th.textContent?.trim();
    const rows = heads.map((th, index) => ({ label: label(th), head: getComputedStyle(th).textAlign,
      cell: firstRow[index] ? getComputedStyle(firstRow[index]).textAlign : null }));
    const help = table.querySelector(".si-table-heading .si-info-tooltip-trigger");
    const trend = table.querySelector("tbody tr[data-row-id] .si-status-cells svg");
    const rects = trend ? [...trend.querySelectorAll("rect")] : [];
    const link = heads.find((th) => label(th) === "链接");
    return { rows, help: help ? { width: help.getBoundingClientRect().width, height: help.getBoundingClientRect().height,
      padding: getComputedStyle(help).paddingLeft, border: getComputedStyle(help).borderWidth } : null,
      trend: trend ? { count: rects.length, gaps: rects.slice(1).map((rect, index) =>
        rect.getBoundingClientRect().left - rects[index].getBoundingClientRect().right),
      lastRight: rects.at(-1)?.getBoundingClientRect().right, cellRight: trend.closest("td")?.getBoundingClientRect().right } : null,
      link: link ? { width: link.clientWidth, content: link.scrollWidth } : null };
  });
  await page.screenshot({ path: path.join(reportDir, `packaged-products-${Math.round(scale * 100)}pct.png`) });
  await session.detach();
  return result;
}

try {
  await mkdir(reportDir, { recursive: true });
  report.installerSha256 = await sha256(installer);
  assert.equal(report.installerSha256, expectedHash, "Fixed installer hash changed");
  for (const directory of Object.values(layout)) if (typeof directory === "string") await mkdir(directory, { recursive: true });
  assert(Object.values(await inspectWindowsProfileLayout(layout)).every((check) => check.withinRoot && check.noReparse), "Profile isolation failed");
  redirect = createWindowsAppDataRedirect({ appDataRoot: layout.appDataRoot,
    runRegistry: (args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }) });
  redirect.redirect();
  report.stage = "install";
  call(installer, ["/S", `/D=${layout.installDir}`], { env: env() });
  assert(await exists(exe), "Installed SiteIndex.exe is missing");
  assert(await exists(path.join(layout.installDir, "resources/fonts")), "Offline fonts are missing");
  await mkdir(path.join(layout.appDataRoot, "SiteIndex"), { recursive: true });
  await writeFile(path.join(layout.appDataRoot, "SiteIndex/settings.json"), JSON.stringify({
    device_id: "synthetic-v083-runner", device_name: "Synthetic Windows runner",
    projects_root: layout.projectRoot, extra_projects: [], hidden_projects: [],
    close_to_tray: false, launch_at_login: false, cache_dir: path.join(root, "cache"),
    browser: { channel: "msedge", executable_path: null },
    notify: { on_failure: true, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [], conflict_patterns: [],
  }, null, 2) + "\n");
  await makeProject();
  report.checks.push({ name: "fixed NSIS install and font assets", pass: true });

  report.stage = "seed old UI state";
  await launch();
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  const loadedFonts = await page.evaluate(() => [...document.fonts]
    .filter((font) => font.status === "loaded" && font.family.includes("Geist")).length);
  assert(loadedFonts > 0, "Bundled Geist font did not load offline");
  report.checks.push({ name: "bundled font loads offline", pass: true, loadedFonts });
  const created = await page.evaluate((directory) => window.siteindex.projects.addExisting(directory), projectDir);
  assert.equal(created.id, projectId);
  const settings = await page.evaluate(() => window.siteindex.settings.get());
  if (expectedVersion === "0.8.4") {
    report.stage = "global page smoke";
    for (const [route, title, screenshot] of [
      ["/", "项目中心", "packaged-project-center.png"],
      ["/skills", "Skill 中心", "packaged-skills.png"],
      ["/schedules", "定时任务", "packaged-schedules.png"],
    ]) {
      await page.evaluate((nextRoute) => { window.location.hash = `#${nextRoute}`; }, route);
      await page.getByRole("heading", { name: title, level: 1 }).waitFor({ timeout: 30_000 });
      const frame = page.locator(".si-page-frame-global");
      const geometry = await frame.evaluate((element) => ({
        header: element.querySelector(".si-page-frame-header")?.getBoundingClientRect().height ?? 0,
        bottom: Number.parseFloat(getComputedStyle(element.querySelector(".si-page-frame-body")).paddingBottom),
      }));
      assert(geometry.header >= 72 && geometry.bottom >= 24, `${title} global frame spacing is missing`);
      if (route === "/") assert(await page.locator("button.si-kpi-card.is-interactive").count() > 0, "Interactive KPI card is missing");
      if (route === "/schedules") await page.locator(".si-table-section .si-data-table").waitFor({ timeout: 30_000 });
      await page.screenshot({ path: path.join(reportDir, screenshot) });
    }
    report.checks.push({ name: "packaged project center, skills and schedules", pass: true });
  }
  const cacheDir = path.resolve(settings.cache_dir);
  const cacheRelative = path.relative(root, cacheDir);
  assert(cacheRelative && !cacheRelative.startsWith("..") && !path.isAbsolute(cacheRelative), "UI state cache escaped isolated profile");
  await stop();
  const stateFile = path.join(cacheDir, projectId, "ui-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ columns: { [tableId]: oldColumns }, page_sizes: {} }, null, 2) + "\n");
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).columns[tableId], oldColumns);

  report.stage = "product UI save and restart";
  await launch();
  await openProducts();
  const original = await headers();
  assert.deepEqual(original, ["SKU", "产品名称", "库存状态", "30 天在线率", "价格", "操作"]);
  await dragPriceBeforeStock();
  assert.deepEqual(await headers(), original, "Dragging changed columns before Save");
  await page.getByRole("button", { name: "取消" }).click();
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).columns[tableId], oldColumns, "Cancel wrote UI state");
  await dragPriceBeforeStock();
  await page.getByRole("button", { name: "保存" }).click();
  const saved = ["SKU", "产品名称", "价格", "库存状态", "30 天在线率", "操作"];
  await page.waitForFunction((expected) => [...document.querySelectorAll('[aria-label="products.merged 数据表"] thead th')]
    .map((th) => th.querySelector(".si-sort-button")?.textContent?.trim() || th.textContent?.trim()).filter(Boolean).join("|") === expected.join("|"), saved);
  await page.waitForFunction(async (id) => (await window.siteindex.uiState.get(id)).columns["products.merged"]
    ?.join("|") === ["sku", "product", "price", "stock_status", "online_rate_30d", "actions"].join("|"), projectId);
  assert.deepEqual((await page.evaluate((id) => window.siteindex.uiState.get(id), projectId)).columns[tableId],
    JSON.parse(await readFile(stateFile, "utf8")).columns[tableId], "IPC and file differ after Save");
  await stop();
  await launch();
  await openProducts();
  assert.deepEqual(await headers(), saved, "Column order was lost after process restart");
  report.checks.push({ name: "old cache, Cancel, Save, IPC/file, restart", pass: true, headers: saved });

  report.stage = "alignment and scaled trend";
  await page.getByRole("button", { name: "列设置" }).click();
  const boxes = page.locator('.si-column-popover [role="checkbox"]');
  for (let index = 0; index < await boxes.count(); index += 1) {
    const box = boxes.nth(index);
    if (await box.getAttribute("aria-checked") === "false" && !await box.isDisabled()) await box.click();
  }
  await page.getByRole("button", { name: "保存" }).click();
  const expectedAlign = { SKU: "left", 产品名称: "left", 库存状态: "left", "近 30 天趋势": "left",
    分类: "left", 最近变化: "left", 持续: "right", "30 天在线率": "right",
    有货变体: "right", 价格: "right", "评分 / 评价数": "right", 链接: "center", 操作: "center" };
  for (const scale of [1.25, 1.5]) {
    const result = await inspect(scale);
    for (const row of result.rows) {
      const align = expectedAlign[row.label];
      if (align) assert(row.head === align && row.cell === align, `${row.label} alignment at ${scale}`);
    }
    assert(result.help && Math.abs(result.help.width - expectedHelpSize) <= 1 && Math.abs(result.help.height - expectedHelpSize) <= 1
      && result.help.padding === "0px" && result.help.border === "0px", "Header info icon is oversized");
    assert(result.link && result.link.content <= result.link.width, "Link header is truncated");
    assert(result.trend?.count === 30 && result.trend.gaps.every((gap) => gap >= 1.9)
      && result.trend.lastRight <= result.trend.cellRight - 1, "30-day trend cells touch or clip");
    report.checks.push({ name: `packaged CDP scale ${scale}`, pass: true,
      minGapCssPx: Math.min(...result.trend.gaps), lastGapCssPx: result.trend.cellRight - result.trend.lastRight });
  }
  await stop();
  report.stage = "packaged --run-job";
  await writeFile(path.join(projectDir, "index/.runner.json"), JSON.stringify({
    device_id: settings.device_id, device_name: settings.device_name, claimed_at: new Date().toISOString(),
  }, null, 2) + "\n");
  const beforeRuns = (await readFile(path.join(projectDir, "index/logs/runs.jsonl"), "utf8")).trim().split(/\r?\n/u).filter(Boolean).length;
  call(exe, ["--run-job", projectDir, "views"], { env: env(), timeout: 300_000 });
  const runs = (await readFile(path.join(projectDir, "index/logs/runs.jsonl"), "utf8")).trim().split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line)).slice(beforeRuns);
  assert(runs.some((row) => row.job === "views" && row.status === "ok")
    && !await exists(path.join(projectDir, "index/.lock")), "Packaged views job did not complete cleanly");
  report.checks.push({ name: "packaged --run-job views", pass: true });
  report.outcome = "pass";
} catch (error) {
  report.outcome = "fail";
  report.error = String(error?.stack ?? error).replaceAll(root, "<isolated>").slice(0, 1600);
  process.exitCode = 1;
} finally {
  if (processHandle?.exitCode === null) processHandle.kill();
  await browser?.close().catch(() => undefined);
  if (await exists(path.join(layout.installDir, "Uninstall SiteIndex.exe"))) {
    try { call(path.join(layout.installDir, "Uninstall SiteIndex.exe"), ["/S", `_?=${layout.installDir}`], { env: env() }); }
    catch (error) { report.cleanupError = String(error?.message ?? error); process.exitCode = 1; }
  }
  if (redirect && !redirect.restore()) { report.cleanupError = "Roaming AppData registry restoration failed"; process.exitCode = 1; }
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`v${expectedVersion} packaged table acceptance: ${report.outcome}; stage=${report.stage}`);
}
