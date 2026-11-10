import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeW2SyntheticFixture, W2_SYNTHETIC_EXPECTED } from "./e-windows-v040-synthetic-fixture.mjs";

const OLD_RELEASE = {
  tag: "v0.3.0",
  commit: "9dca729763ff6474e9baf182aac01213c81430a9",
  sha256: "5b0ffb1e5c74b743c5938bd62349ef0b9fe69a87f05dfc8f56adf25c26f77bdd",
};
const CANDIDATE_VERSION = process.env.SITEINDEX_CANDIDATE_VERSION?.trim() || "0.4.0";
const W2_PROJECT_ID = "synthetic-w2-pages";
const W2_EXPECTED = W2_SYNTHETIC_EXPECTED;
const CDP_PORT = 9333;
const OUTPUT_DIR = process.env.SITEINDEX_ACCEPTANCE_OUTPUT;
const APP_DATA_ROOT = process.env.APPDATA;
const TEST_ROOT = await fsMkdtemp();
const PROJECTS_ROOT = path.join(TEST_ROOT, "projects");
const INSTALL_DIR = path.join(TEST_ROOT, "installed-app");
const APP_DATA_DIR = APP_DATA_ROOT ? path.join(APP_DATA_ROOT, "SiteIndex") : "";
const SETTINGS_FILE = APP_DATA_DIR ? path.join(APP_DATA_DIR, "settings.json") : "";
const TRACE_LOG_NAME = "siteindex-trace.log";
const TRACE_SEARCH_ROOTS = [
  APP_DATA_DIR,
  APP_DATA_ROOT ? path.join(APP_DATA_ROOT, "siteindex-desktop") : "",
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "SiteIndex") : "",
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "siteindex") : "",
].filter(Boolean);
const report = {
  sourceCommit: null,
  prHeadCommit: process.env.SITEINDEX_PR_HEAD_SHA || null,
  expectedSourceCommit: process.env.SITEINDEX_EXPECTED_SOURCE_COMMIT || null,
  candidateVersion: CANDIDATE_VERSION,
  candidateArtifactSource: process.env.SITEINDEX_CANDIDATE_ARTIFACT_SOURCE || "runner-built-internal-candidate",
  candidateWorkflowRunId: process.env.SITEINDEX_CANDIDATE_ARTIFACT_RUN_ID || process.env.SITEINDEX_CANDIDATE_WORKFLOW_RUN_ID || null,
  candidateArtifactId: process.env.SITEINDEX_CANDIDATE_ARTIFACT_ID || null,
  candidateArtifactName: process.env.SITEINDEX_CANDIDATE_ARTIFACT_NAME || null,
  candidateArtifactSha256: process.env.SITEINDEX_CANDIDATE_ARTIFACT_SHA256 || null,
  expectedCandidateArtifactSha256: process.env.SITEINDEX_EXPECTED_CANDIDATE_ARTIFACT_SHA256 || null,
  candidateSourceCommit: process.env.SITEINDEX_CANDIDATE_SOURCE_COMMIT || process.env.SITEINDEX_EXPECTED_CANDIDATE_SOURCE_COMMIT || null,
  expectedCandidateSourceCommit: process.env.SITEINDEX_EXPECTED_CANDIDATE_SOURCE_COMMIT || null,
  runnerBuildVersionOverride: process.env.SITEINDEX_CANDIDATE_ARTIFACT_SOURCE === "runner-built-internal-candidate",
  previousRelease: { ...OLD_RELEASE },
  candidateInstallerSha256: null,
  windows: {
    version: process.env.SITEINDEX_WINDOWS_VERSION || os.version(),
    build: process.env.SITEINDEX_WINDOWS_BUILD || null,
    runnerImage: process.env.SITEINDEX_RUNNER_IMAGE || "windows-2025",
    architecture: os.arch(),
  },
  checks: [],
  addExistingTrace: null,
  traceEnvironmentPassedToSpawn: false,
  visualEvidence: null,
  w2Acceptance: {
    candidateVersion: CANDIDATE_VERSION,
    candidateArtifactSource: "workflow-run-artifact",
    syntheticProject: true,
    realProjectUsed: false,
    evidenceLegend: {
      ui: "Packaged Electron renderer DOM with Playwright interaction through CDP.",
      packagedIpc: "window.siteindex calls from the packaged renderer, crossing preload/IPC into the packaged desktop/core handlers.",
      notVerified: "No assertion was possible in this runner.",
    },
    checks: [],
  },
  uncovered: [
    "settings UI for close_to_tray and launch_at_login, plus tray and login-start behavior",
    "Skills Center installation/version status in ~/.agents/skills and retired edm-builder status",
    "full legacy feature matrix and golden tests beyond project read/query, settings persistence, and byte comparison",
    "manual Windows 10/11 and real-project migration, visual, accessibility, and native UAC checks",
  ],
};

let currentStage = "preflight";
let applicationProcess = null;
let browserConnection = null;
let candidateInstalled = false;
let testProfileCreated = false;
let failed = null;
let workspaceProbeData = null;
let syntheticSiteServer = null;

function record(name, passed, evidence = {}) {
  report.checks.push({ name, status: passed ? "passed" : "failed", evidence });
  if (!passed) throw new Error(`Acceptance assertion failed: ${name}`);
}

function assert(condition, name, evidence = {}) {
  record(name, Boolean(condition), evidence);
}

function recordW2(name, passed, evidenceType, evidence = {}) {
  const entry = {
    name,
    status: passed ? "passed" : "failed",
    evidenceType,
    evidence,
  };
  report.w2Acceptance.checks.push(entry);
  report.checks.push(entry);
}

function safeMessage(error) {
  const source = error instanceof Error ? error.message : String(error);
  let safe = source.replaceAll(TEST_ROOT, "<TEST_ROOT>").replaceAll(INSTALL_DIR, "<INSTALL_DIR>");
  if (APP_DATA_DIR) safe = safe.replaceAll(APP_DATA_DIR, "<APP_DATA>");
  return safe
    .replace(/\bhttps?:\/\/[^\s)]+/giu, "<URL>")
    .replace(/[A-Z]:\\[^\r\n"']+/giu, "<PATH>");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

async function fsMkdtemp() {
  const root = path.join(os.tmpdir(), `siteindex-e-acceptance-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 300_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${path.basename(file)} exited with code ${result.status ?? "unknown"}`);
    error.code = `EXIT_${result.status ?? "UNKNOWN"}`;
    throw error;
  }
  return result;
}

function hasInstalledSiteIndex() {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const root of roots) {
    const result = spawnSync("reg.exe", ["query", root, "/s"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) continue;
    const entries = result.stdout.split(/(?=HKEY_)/iu);
    if (entries.some((entry) => /^\s*DisplayName\s+REG_\w+\s+SiteIndex(?:\s+\d+(?:\.\d+)*)?\s*$/imu.test(entry))) {
      return true;
    }
  }
  return false;
}

async function install(installerPath) {
  run(installerPath, ["/S", `/D=${INSTALL_DIR}`]);
}

async function writeRunnerSettings() {
  if (!APP_DATA_ROOT) throw new Error("APPDATA is unavailable on this Windows runner.");
  await mkdir(APP_DATA_DIR, { recursive: true });
  testProfileCreated = true;
  await writeFile(
    SETTINGS_FILE,
    `${JSON.stringify({
      device_id: "e-acceptance-synthetic-runner",
      device_name: "Synthetic Windows runner",
      projects_root: PROJECTS_ROOT,
      extra_projects: [],
      hidden_projects: [],
      cache_dir: path.join(TEST_ROOT, "cache"),
      browser: { channel: "msedge", executable_path: null },
      notify: { on_failure: true, on_success: true, oos_threshold: null, dingtalk_webhook: null },
      skill_platforms: [],
      conflict_patterns: [],
    }, null, 2)}\n`,
    "utf8",
  );
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function disabledSchedule() {
  const job = { enabled: false, days: [], time: "00:00" };
  return {
    daily: { ...job },
    validate: { ...job },
    weekly: { ...job },
    readme: { ...job },
    monthly: { ...job, day_of_month: 1 },
    options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false },
  };
}

async function makeLegacyProject(directory, name = "Synthetic legacy project") {
  await mkdir(path.join(directory, "index", "catalog"), { recursive: true });
  const config = {
    schema_version: "1.0",
    domain: "legacy.example.invalid",
    base_url: "https://legacy.example.invalid",
    platform: "woocommerce",
    currency: "USD",
    locale: "en-US",
    timezone: "UTC",
    markets: ["US"],
    brand: { name, tagline: "Synthetic migration fixture" },
    sitemaps: [],
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 200 },
    categories: { mode: "feed" },
    workspace_folders: [],
    schedule: disabledSchedule(),
  };
  await writeFile(path.join(directory, "index", "site.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(path.join(directory, "index", "catalog", "skus.jsonl"), '{"sku":"SYN-001","handle":"fixture-item","status":"active"}\n', "utf8");
  await writeFile(path.join(directory, "user-owned.txt"), "synthetic-data-survives-upgrade\n", "utf8");
}

async function writeJsonlFile(filePath, rows) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
}

async function makeW2SyntheticProject(directory, origin) {
  const fixture = makeW2SyntheticFixture(origin);
  await mkdir(directory, { recursive: true });
  const index = path.join(directory, "index");
  await mkdir(path.join(index, "catalog"), { recursive: true });
  await mkdir(path.join(index, "inventory", "events"), { recursive: true });
  await mkdir(path.join(index, "views"), { recursive: true });
  await mkdir(path.join(index, "seo"), { recursive: true });
  await mkdir(path.join(index, "content"), { recursive: true });
  await mkdir(path.join(index, "ledgers"), { recursive: true });
  await mkdir(path.join(index, "logs"), { recursive: true });
  await writeFile(path.join(index, "site.json"), JSON.stringify(fixture.config, null, 2) + "\n", "utf8");
  await writeJsonlFile(path.join(index, "catalog", "skus.jsonl"), fixture.skus.sort((a, b) => a.sku.localeCompare(b.sku)));
  await writeJsonlFile(path.join(index, "catalog", "product_details.jsonl"), fixture.productDetails);
  await writeJsonlFile(path.join(index, "inventory", "latest.jsonl"), fixture.latest.sort((a, b) => a.sku.localeCompare(b.sku)));
  await writeJsonlFile(path.join(index, "views", "sku_stock.jsonl"), fixture.skuStock.sort((a, b) => a.sku.localeCompare(b.sku)));
  await writeJsonlFile(path.join(index, "views", "products.jsonl"), fixture.products.sort((a, b) => a.handle.localeCompare(b.handle)));
  await writeJsonlFile(path.join(index, "seo", "pages.jsonl"), fixture.seoPages);
  await writeJsonlFile(path.join(index, "seo", "issues.jsonl"), fixture.seoIssues);
  await writeJsonlFile(path.join(index, "seo", "links.jsonl"), fixture.seoLinks);
  await writeJsonlFile(path.join(index, "content", "blog_index.jsonl"), fixture.blogs);
  await writeJsonlFile(path.join(index, "content", "keywords.jsonl"), []);
  await writeJsonlFile(path.join(index, "ledgers", "edm_campaigns.jsonl"), []);
  await writeJsonlFile(path.join(index, "ledgers", "outreach.jsonl"), fixture.outreach);
  await writeJsonlFile(path.join(index, "logs", "runs.jsonl"), []);
  for (const month of ["2026-10", "2026-11"]) {
    await writeJsonlFile(path.join(index, "inventory", "events", month + ".jsonl"),
      fixture.events.filter((event) => event.date.startsWith(month)));
  }
  const summaryLines = fixture.dailySummaryRows.map((row) =>
    [row.date, row.category, row.total, row.in_stock, row.out_of_stock, row.preorder, row.unknown].join(","));
  await writeFile(path.join(index, "inventory", "daily_summary.csv"),
    "date,category,total,in_stock,out_of_stock,preorder,unknown\n" + summaryLines.join("\n") + "\n", "utf8");
  await writeFile(path.join(index, "catalog", "categories.json"), JSON.stringify(fixture.categories, null, 2) + "\n", "utf8");
  await writeFile(path.join(index, "ledgers", "sku_media.csv"), "sku,image_role,image_url,alt_text,source,width,height,updated_at\n", "utf8");
  await writeFile(path.join(index, "ledgers", "sku_tags.csv"), "sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at\n", "utf8");
  return {
    ...fixture.summary,
    skuCount: fixture.summary.totalSkus,
    productCount: fixture.summary.products,
    blogCount: fixture.summary.blogsBeforeRefresh,
    issueCount: fixture.summary.issues,
  };
}
async function startSyntheticSite() {
  let requestCount = 0;
  let failedRequestCount = 0;
  let origin = "";
  const send = (response, status, contentType, body) => {
    response.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-store" });
    response.end(body);
  };
  syntheticSiteServer = createServer((request, response) => {
    requestCount += 1;
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET") {
      failedRequestCount += 1;
      return send(response, 405, "text/plain", "GET only");
    }
    if (pathname === "/sitemap.xml") {
      return send(response, 200, "application/xml", `<?xml version="1.0"?><urlset><url><loc>${origin}/products/group-000</loc></url></urlset>`);
    }
    if (pathname === "/blog-sitemap.xml") {
      return send(response, 200, "application/xml", `<?xml version="1.0"?><urlset><url><loc>${origin}/blog/refreshed-one</loc></url><url><loc>${origin}/blog/refreshed-two</loc></url></urlset>`);
    }
    const isBlog = pathname === "/blog/refreshed-one" || pathname === "/blog/refreshed-two";
    if (isBlog || pathname === "/products/group-000") {
      const title = isBlog ? "Synthetic refreshed blog" : "Synthetic product page";
      const kind = isBlog ? "BlogPosting" : "Product";
      const body = `<!doctype html><html><head><title>${title}</title><meta name="description" content="Synthetic local acceptance page."><link rel="canonical" href="${origin}${pathname}"><script type="application/ld+json">{"@type":"${kind}","headline":"${title}","name":"${title}"}</script></head><body><main><article><h1>${title}</h1><p>Synthetic local acceptance content.</p><a href="/products/group-000">Synthetic link</a></article></main></body></html>`;
      return send(response, 200, "text/html", body);
    }
    failedRequestCount += 1;
    return send(response, 404, "text/plain", "Synthetic route not found");
  });
  await new Promise((resolve, reject) => {
    syntheticSiteServer.once("error", reject);
    syntheticSiteServer.listen(0, "127.0.0.1", resolve);
  });
  const address = syntheticSiteServer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic acceptance site did not bind a local TCP port.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    metrics: () => ({ requestCount, failedRequestCount }),
  };
}

async function closeSyntheticSite() {
  if (!syntheticSiteServer) return;
  syntheticSiteServer.closeAllConnections?.();
  await new Promise((resolve) => syntheticSiteServer.close(resolve));
  syntheticSiteServer = null;
}

async function snapshotTree(directory) {
  const hashes = {};
  async function visit(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) hashes[relative] = await fileSha256(absolute);
      else throw new Error("Synthetic project contains an unsupported file entry.");
    }
  }
  await visit(directory, "");
  return hashes;
}

async function launchInstalledApp({ executablePath, trace = false }) {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (response.ok) throw new Error("CDP acceptance port is already in use.");
  } catch (error) {
    if (error instanceof Error && error.message === "CDP acceptance port is already in use.") throw error;
  }
  const environment = { ...process.env, ELECTRON_RENDERER_URL: "", SITEINDEX_UI_URL: "" };
  if (trace) environment.SITEINDEX_TRACE = "1";
  else delete environment.SITEINDEX_TRACE;
  report.traceEnvironmentPassedToSpawn = trace && environment.SITEINDEX_TRACE === "1";
  applicationProcess = spawn(executablePath, [`--remote-debugging-port=${CDP_PORT}`, "--disable-gpu"], {
    env: environment,
    stdio: "ignore",
    windowsHide: false,
  });
  applicationProcess.on("error", () => undefined);
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) break;
    } catch (error) {
      lastError = error;
    }
    if (applicationProcess.exitCode !== null) throw new Error("Packaged SiteIndex process exited before CDP became ready.");
    await delay(500);
  }
  if (Date.now() >= deadline) throw new Error(lastError ? "Packaged SiteIndex CDP endpoint did not start." : "Packaged SiteIndex CDP timed out.");

  browserConnection = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
  const deadlineForPage = Date.now() + 60_000;
  let page = null;
  while (Date.now() < deadlineForPage) {
    const pages = browserConnection.contexts().flatMap((context) => context.pages());
    page = pages.find((candidate) => candidate.url().startsWith("file:") && candidate.url().includes("/ui/index.html")) ?? null;
    if (page) break;
    await delay(300);
  }
  if (!page) throw new Error("Packaged app did not load the complete file-based UI page.");
  await page.waitForFunction(() => typeof window.siteindex === "object" && window.siteindex !== null, null, { timeout: 30_000 });
  await delay(300);
  if (applicationProcess.exitCode !== null) throw new Error("Packaged app process exited after CDP attached; refusing to use another app instance.");
  return page;
}

async function findTraceLogs(root, depth = 5) {
  if (depth < 0 || !(await exists(root))) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === TRACE_LOG_NAME) found.push(absolute);
    else if (entry.isDirectory() && !entry.isSymbolicLink() && depth > 0) {
      found.push(...await findTraceLogs(absolute, depth - 1));
    }
  }
  return found;
}

async function traceRoots() {
  const roots = new Set(TRACE_SEARCH_ROOTS);
  for (const base of [APP_DATA_ROOT, process.env.LOCALAPPDATA].filter(Boolean)) {
    let entries = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/site.?index|@siteindex/iu.test(entry.name)) continue;
      const candidate = path.join(base, entry.name);
      roots.add(candidate);
      if (entry.name === "@siteindex") roots.add(path.join(candidate, "desktop"));
    }
  }
  return [...roots];
}

async function readTraceLogs() {
  const files = new Set();
  const roots = await traceRoots();
  for (const root of roots) {
    for (const file of await findTraceLogs(root)) files.add(file);
  }
  const contents = await Promise.all([...files].map((file) => readFile(file, "utf8").catch(() => "")));
  const locations = [...files].map((file) => {
    if (APP_DATA_ROOT && file.toLowerCase().startsWith(APP_DATA_ROOT.toLowerCase())) return "roaming-app-data";
    if (process.env.LOCALAPPDATA && file.toLowerCase().startsWith(process.env.LOCALAPPDATA.toLowerCase())) return "local-app-data";
    return "other-siteindex-data";
  });
  return { rootCount: roots.length, fileCount: files.size, locations: [...new Set(locations)], text: contents.join("\n") };
}

async function stopApplication() {
  if (browserConnection) {
    await browserConnection.close().catch(() => undefined);
    browserConnection = null;
  }
  if (applicationProcess?.pid) {
    spawnSync("taskkill.exe", ["/PID", String(applicationProcess.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
  }
  applicationProcess = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (!response.ok) break;
    } catch {
      break;
    }
    await delay(200);
  }
}

async function appState(page) {
  return page.evaluate(async () => {
    const api = window.siteindex;
    const [version, projects, settings] = await Promise.all([
      api.app.version(),
      api.projects.list(),
      api.settings.get(),
    ]);
    return {
      version,
      projectIds: projects.map((project) => project.id),
      projectCount: projects.length,
      activeSkuCounts: projects.map((project) => project.sku_count),
      settings: {
        close_to_tray: settings.close_to_tray,
        launch_at_login: settings.launch_at_login,
        projects_root: settings.projects_root,
      },
    };
  });
}

async function goToW2Route(page, route) {
  await page.evaluate((nextRoute) => { window.location.hash = `#${nextRoute}`; }, route);
  await page.waitForFunction((nextRoute) => window.location.hash === `#${nextRoute}`, route, { timeout: 15_000 });
  await page.locator(".si-page").first().waitFor({ state: "visible", timeout: 15_000 });
}

async function clickProjectTab(page, label) {
  if (await page.locator(".si-drawer").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "关闭抽屉", exact: true }).click();
  }
  if (await page.locator(".si-detail-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  }
  const tab = page.getByRole("tab", { name: label, exact: true });
  if (await tab.count()) {
    await tab.click();
    await page.locator(".si-page").first().waitFor({ state: "visible", timeout: 15_000 });
    return "tab-click";
  }
  await goToW2Route(page, `/p/${W2_PROJECT_ID}${label === "概览" ? "" : `/${({ 库存: "inventory", 产品: "products", SEO: "seo", 内容: "content", EDM: "edm" })[label] ?? ""}`}`);
  return "route-fallback";
}

async function waitForW2Table(page) {
  await page.locator(".si-data-table").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".si-data-table .si-pagination-count").first().waitFor({ state: "visible", timeout: 20_000 });
}

async function readW2TableMetrics(page) {
  return page.evaluate(() => {
    const table = document.querySelector(".si-data-table");
    const count = table?.querySelector(".si-pagination-count")?.textContent?.trim() ?? "";
    const match = count.match(/\/(\s*[\d,]+)/u);
    return {
      tableVisible: Boolean(table && table.getBoundingClientRect().height > 0),
      scrollRegionVisible: Boolean(table?.querySelector(".si-table-scroll")?.getBoundingClientRect().height),
      renderedRows: table?.querySelectorAll("tbody tr[data-row-id]").length ?? 0,
      paginationVisible: Boolean(table?.querySelector(".si-pagination")?.getBoundingClientRect().height),
      paginationText: count,
      total: match ? Number(match[1].replaceAll(",", "").trim()) : null,
      pageSize: table?.querySelector('select[aria-label="每页条数"]')?.value ?? null,
      nextEnabled: table?.querySelector('button[aria-label="下一页"]') instanceof HTMLButtonElement
        && !table.querySelector('button[aria-label="下一页"]').disabled,
      headerCount: table?.querySelectorAll("thead th").length ?? 0,
    };
  });
}

async function exerciseW2Pagination(page, expectedTotal) {
  const before = await readW2TableMetrics(page);
  let advanced = false;
  let returned = false;
  if (before.nextEnabled) {
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.waitForFunction((oldText) => {
      const count = document.querySelector(".si-data-table .si-pagination-count")?.textContent?.trim();
      return Boolean(count && count !== oldText);
    }, before.paginationText, { timeout: 10_000 });
    const secondPage = await readW2TableMetrics(page);
    advanced = secondPage.paginationText !== before.paginationText && secondPage.total === expectedTotal;
    if (await page.getByRole("button", { name: "上一页", exact: true }).isEnabled()) {
      await page.getByRole("button", { name: "上一页", exact: true }).click();
      await page.waitForFunction((oldText) => document.querySelector(".si-data-table .si-pagination-count")?.textContent?.trim() === oldText,
        before.paginationText, { timeout: 10_000 });
      returned = true;
    }
  }
  return {
    before,
    expectedTotal,
    advanced,
    returned,
    passed: before.tableVisible && before.scrollRegionVisible && before.paginationVisible
      && before.total === expectedTotal && before.headerCount > 0 && advanced && returned,
  };
}

async function packagedW2Baseline(page) {
  return page.evaluate(async (projectId) => {
    const api = window.siteindex;
    const [inventory, inventorySummary, products, edm, blogPage, blogSummary, issues, pages, links, overview] = await Promise.all([
      api.inventory.listSkus(projectId, { page: 1, pageSize: 0, filters: { parent_only: true } }),
      api.inventory.summary(projectId, 30),
      api.products.list(projectId, { page: 1, pageSize: 0, filters: { parent_only: true } }),
      api.edm.listImages(projectId, { page: 1, pageSize: 0, filters: { parent_only: true } }),
      api.content.listBlog(projectId, { page: 1, pageSize: 0, filters: {} }),
      api.content.summary(projectId),
      api.seo.listIssues(projectId, { page: 1, pageSize: 0, filters: { status: "open" } }),
      api.seo.listPages(projectId, { page: 1, pageSize: 0, filters: {} }),
      api.seo.listLinks(projectId, { page: 1, pageSize: 0, filters: {} }),
      api.overview.get(projectId),
    ]);
    const count = (key) => blogSummary.kpis.find((item) => item.key === key)?.value ?? null;
    const parentInventory = inventory.rows.filter((row) => row.is_parent === true);
    const unmatchedInventory = inventory.rows.filter((row) => row.is_parent !== true && !row.parent_sku);
    const kpi = (key) => inventorySummary.kpis.find((item) => item.key === key)?.value ?? null;
    const trendParent = parentInventory.find((row) => row.sku === "SYN-P001");
    const categoryRate = inventorySummary.category_rates.find((row) => row.category === "synthetic-category");
    const parentProducts = products.rows.filter((row) => row.row_kind === "parent");
    const unmatchedProducts = products.rows.filter((row) => row.row_kind === "single");
    const parentHasThreeOfThree = parentProducts.some((row) => row.variant_count === 3 && row.in_stock_variants === 3);
    const edmParents = edm.rows.filter((row) => /^SYN-P\d{3}$/u.test(row.sku)).length;
    const edmSingles = edm.rows.filter((row) => row.sku.startsWith("SYN-SINGLE-")).length;
    const attentionRule = overview.attention.map((item) => {
      const query = item.link.split("?")[1] ?? "";
      return new URLSearchParams(query).get("rule");
    }).find(Boolean) ?? null;
    return {
      inventory: {
        rows: inventory.total,
        parents: parentInventory.length,
        unmatched: unmatchedInventory.length,
        childrenLeaked: inventory.rows.some((row) => typeof row.parent_sku === "string" && row.parent_sku.length > 0 && row.is_parent !== true),
        summary: { total: kpi("total"), inStock: kpi("in_stock"), outOfStock: kpi("out_of_stock"), categoryRate: categoryRate ?? null },
        parentTrend: trendParent ? {
          sku: trendParent.sku,
          history30d: trendParent.history_30d,
          onlineRate7d: trendParent.online_rate_7d,
          onlineRate30d: trendParent.online_rate_30d,
          changes30d: trendParent.changes_30d,
          lastChangeAt: trendParent.last_change_at,
        } : null,
      },
      products: {
        rows: products.total,
        parents: parentProducts.length,
        unmatched: unmatchedProducts.length,
        childrenLeaked: products.rows.some((row) => row.row_kind === "child"),
        parentHasThreeOfThree,
      },
      edm: {
        rows: edm.total,
        parents: edmParents,
        unmatched: edmSingles,
        childrenLeaked: edm.rows.some((row) => /-CH-\d{2}$/u.test(row.sku)),
      },
      content: { blogs: blogPage.total, summaryBlogs: count("blogs"), summaryNoSchema: count("no_schema") },
      seo: { issues: issues.total, pages: pages.total, links: links.total },
      overview: { attentionCount: overview.attention.length, firstSeoRule: attentionRule },
    };
  }, W2_PROJECT_ID);
}

async function attemptW2(name, evidenceType, action) {
  try {
    const result = await action();
    recordW2(name, result.passed, evidenceType, result.evidence ?? result);
    return result;
  } catch (error) {
    recordW2(name, false, evidenceType, { error: safeMessage(error) });
    return null;
  }
}

async function readW2SeoStatusCounts(page, rule) {
  return page.evaluate(async ({ projectId, targetRule }) => {
    const api = window.siteindex;
    const read = (status) => api.seo.listIssues(projectId, {
      page: 1,
      pageSize: 0,
      filters: { rules: [targetRule], ...(status ? { status } : {}) },
    });
    const [all, open, fixed, ignored] = await Promise.all([read(undefined), read("open"), read("fixed"), read("ignored")]);
    return { all: all.total, open: open.total, fixed: fixed.total, ignored: ignored.total };
  }, { projectId: W2_PROJECT_ID, targetRule: rule });
}

async function waitForW2SeoCount(page, rule, status, count) {
  await page.waitForFunction(async ({ projectId, targetRule, targetStatus, expectedCount }) => {
    const result = await window.siteindex.seo.listIssues(projectId, {
      page: 1, pageSize: 0, filters: { rules: [targetRule], status: targetStatus },
    });
    return result.total === expectedCount;
  }, { projectId: W2_PROJECT_ID, targetRule: rule, targetStatus: status, expectedCount: count }, { timeout: 15_000 });
}

async function testW2Pages(page, syntheticSite) {
  let baseline = null;
  await attemptW2("W2 baseline data is served by the packaged IPC", "packaged-ipc", async () => {
    baseline = await packagedW2Baseline(page);
    const passed = baseline.inventory.rows === W2_EXPECTED.parentGroups + W2_EXPECTED.ungroupedSkus
      && baseline.inventory.parents === W2_EXPECTED.parentGroups
      && baseline.inventory.unmatched === W2_EXPECTED.ungroupedSkus
      && !baseline.inventory.childrenLeaked
      && baseline.inventory.summary.total === String(W2_EXPECTED.totalSkus)
      && baseline.inventory.summary.inStock === String(W2_EXPECTED.inStock)
      && baseline.inventory.summary.outOfStock === String(W2_EXPECTED.outOfStock)
      && baseline.inventory.summary.categoryRate?.total === W2_EXPECTED.totalSkus
      && baseline.inventory.summary.categoryRate?.rate === W2_EXPECTED.inStock / W2_EXPECTED.totalSkus
      && baseline.inventory.parentTrend?.sku === W2_EXPECTED.trendParentSku
      && baseline.inventory.parentTrend?.history30d === W2_EXPECTED.trendHistory30d
      && baseline.inventory.parentTrend?.onlineRate7d === W2_EXPECTED.trendOnlineRate7d
      && baseline.inventory.parentTrend?.onlineRate30d === W2_EXPECTED.trendOnlineRate30d
      && baseline.inventory.parentTrend?.changes30d === 1
      && baseline.inventory.parentTrend?.lastChangeAt === W2_EXPECTED.trendLastChangeAt
      && baseline.products.rows === W2_EXPECTED.products
      && baseline.products.parents === W2_EXPECTED.parentGroups
      && baseline.products.unmatched === W2_EXPECTED.ungroupedSkus
      && !baseline.products.childrenLeaked
      && baseline.products.parentHasThreeOfThree
      && baseline.edm.rows === W2_EXPECTED.products
      && baseline.edm.parents === W2_EXPECTED.parentGroups
      && baseline.edm.unmatched === W2_EXPECTED.ungroupedSkus
      && !baseline.edm.childrenLeaked
      && baseline.content.blogs === W2_EXPECTED.blogsBeforeRefresh
      && baseline.content.summaryBlogs === String(W2_EXPECTED.blogsBeforeRefresh)
      && baseline.content.summaryNoSchema === "0"
      && baseline.seo.issues === W2_EXPECTED.issues
      && baseline.seo.pages === W2_EXPECTED.pages
      && baseline.seo.links === W2_EXPECTED.links
      && baseline.overview.firstSeoRule === "title_missing";
    return { passed, evidence: baseline };
  });

  let overviewRoutePass = false;
  await attemptW2("Overview SEO attention link opens the filtered issues view", "ui", async () => {
    await goToW2Route(page, `/p/${W2_PROJECT_ID}`);
    await page.locator(".si-overview-attention").waitFor({ state: "visible", timeout: 20_000 });
    const link = page.getByRole("link", { name: "查看 SEO 问题" }).first();
    await link.waitFor({ state: "visible", timeout: 10_000 });
    await link.click();
    await page.locator(".si-seo-controls").waitFor({ state: "visible", timeout: 20_000 });
    const selected = await page.evaluate(() => {
      const [, query = ""] = window.location.hash.split("?");
      const params = new URLSearchParams(query);
      return {
        onSeoRoute: window.location.hash.includes("/seo?"),
        rule: params.get("rule"),
        status: params.get("status"),
        selectedFilterText: document.querySelector(".si-seo-selected-filters")?.textContent?.trim() ?? "",
      };
    });
    overviewRoutePass = selected.onSeoRoute && selected.rule === "title_missing" && selected.status === "open";
    return { passed: overviewRoutePass, evidence: selected };
  });

  await attemptW2("SEO issues table renders real packaged rows and advances pagination", "ui", async () => {
    await waitForW2Table(page);
    const pagination = await exerciseW2Pagination(page, W2_EXPECTED.issues - 6);
    const columnText = await page.locator(".si-data-table thead").innerText();
    const statusColumn = columnText.includes("状态");
    const statusFilterVisible = await page.locator('.si-seo-dropdown-trigger[aria-label^="状态"]').isVisible();
    const passed = pagination.passed && statusColumn && statusFilterVisible;
    return { passed, evidence: { ...pagination, statusColumn, statusFilterVisible } };
  });

  await attemptW2("SEO issue action marks a row processed and restores it through the UI", "ui", async () => {
    const before = await readW2SeoStatusCounts(page, "title_missing");
    await page.once("dialog", (dialog) => { void dialog.accept(); });
    await page.getByRole("button", { name: /问题操作：/u }).first().click();
    await page.getByRole("menuitem", { name: "标记已处理", exact: true }).click();
    await waitForW2SeoCount(page, "title_missing", "fixed", 1);
    await page.waitForFunction((expected) => {
      const count = document.querySelector(".si-data-table .si-pagination-count")?.textContent ?? "";
      return count.includes(`/ ${expected}`);
    }, String(before.open - 1), { timeout: 10_000 });
    const afterFixed = await readW2SeoStatusCounts(page, "title_missing");
    const statusFilter = page.locator('.si-seo-dropdown-trigger[aria-label^="状态"]');
    await statusFilter.click();
    await page.getByRole("group", { name: "状态" }).getByRole("button", { name: "已处理", exact: true }).click();
    await waitForW2Table(page);
    await page.once("dialog", (dialog) => { void dialog.accept(); });
    await page.getByRole("button", { name: /问题操作：/u }).first().click();
    await page.getByRole("menuitem", { name: "恢复为待处理", exact: true }).click();
    await waitForW2SeoCount(page, "title_missing", "open", W2_EXPECTED.issues - 6);
    const statusCounts = await readW2SeoStatusCounts(page, "title_missing");
    const passed = before.open === W2_EXPECTED.issues - 6
      && afterFixed.fixed === before.fixed + 1
      && statusCounts.open === W2_EXPECTED.issues - 6
      && statusCounts.fixed === 0;
    return { passed, evidence: { before, afterFixed, afterRestore: statusCounts, restoredToOpen: statusCounts.open === before.open } };
  });

  await attemptW2("SEO rules Drawer ignores and restores a rule class", "ui", async () => {
    await clickProjectTab(page, "SEO");
    await page.locator(".si-seo-controls").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: "规则设置", exact: true }).click();
    const ruleSection = page.locator(".si-seo-rule-setting").filter({ hasText: "Title 缺失" }).first();
    await ruleSection.waitFor({ state: "visible", timeout: 15_000 });
    const before = await readW2SeoStatusCounts(page, "title_missing");
    await page.once("dialog", (dialog) => { void dialog.accept(); });
    await ruleSection.getByRole("button", { name: "忽略此规则", exact: true }).click();
    await ruleSection.getByRole("button", { name: "恢复此规则", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await waitForW2SeoCount(page, "title_missing", "ignored", W2_EXPECTED.issues - 6);
    const ignored = await readW2SeoStatusCounts(page, "title_missing");
    await page.once("dialog", (dialog) => { void dialog.accept(); });
    await ruleSection.getByRole("button", { name: "恢复此规则", exact: true }).click();
    await waitForW2SeoCount(page, "title_missing", "open", W2_EXPECTED.issues - 6);
    const restored = await readW2SeoStatusCounts(page, "title_missing");
    const passed = before.open === W2_EXPECTED.issues - 6
      && ignored.ignored === before.open
      && restored.open === before.open
      && restored.ignored === 0;
    await page.getByRole("button", { name: "关闭抽屉", exact: true }).click();
    return { passed, evidence: { before, ignored, restored, drawerOpened: true } };
  });

  await attemptW2("Inventory table renders rows and paginates", "ui", async () => {
    await clickProjectTab(page, "库存");
    await waitForW2Table(page);
    const pagination = await exerciseW2Pagination(page, W2_EXPECTED.totalSkus);
    return { passed: pagination.passed, evidence: pagination };
  });

  await attemptW2("Inventory parent-only UI shows parents plus ungrouped SKUs", "ui", async () => {
    const checkbox = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    await checkbox.check();
    await page.waitForFunction(() => document.querySelector(".si-pagination-count")?.textContent?.includes("/ 80"), null, { timeout: 10_000 });
    const metrics = await readW2TableMetrics(page);
    const toolbarText = await page.locator(".si-table-total").innerText();
    const rowIds = await page.locator(".si-data-table tbody tr[data-row-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id") ?? ""));
    const childrenVisible = rowIds.some((value) => /-CH-\d{2}$/u.test(value));
    const passed = metrics.total === W2_EXPECTED.parentGroups + W2_EXPECTED.ungroupedSkus
      && await checkbox.isChecked() && !childrenVisible && toolbarText.includes("父 SKU");
    return { passed, evidence: { ...metrics, childrenVisible, toolbarShowsParentView: toolbarText.includes("父 SKU") } };
  });

  await attemptW2("Products parent-only UI shows grouped products and 3/3 in-stock variants", "ui", async () => {
    await clickProjectTab(page, "产品");
    await waitForW2Table(page);
    const pagination = await exerciseW2Pagination(page, W2_EXPECTED.products);
    const checkbox = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    await checkbox.check();
    await page.waitForFunction(() => document.querySelector(".si-data-table")?.innerText.includes("3/3"), null, { timeout: 10_000 });
    const metrics = await readW2TableMetrics(page);
    const row = page.locator('.si-data-table tbody tr[data-row-id]').filter({ hasText: "Synthetic grouped product 000" }).first();
    await row.click();
    const panel = page.locator(".si-detail-panel");
    await panel.waitFor({ state: "visible", timeout: 15_000 });
    const inventoryHeading = await panel.getByText("变体库存", { exact: true }).isVisible();
    const variantRows = await panel.locator(".si-data-table tbody tr[data-row-id]").count();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden", timeout: 10_000 });
    const passed = pagination.passed && metrics.total === W2_EXPECTED.products
      && await checkbox.isChecked() && inventoryHeading && variantRows === W2_EXPECTED.childrenPerGroup;
    return { passed, evidence: { pagination, parentOnlyTotal: metrics.total, groupedVariantCellVisible: true, productDrawerShowsStock: inventoryHeading, visibleVariantRows: variantRows } };
  });

  await attemptW2("EDM table paginates and parent-only UI hides child SKU rows", "ui", async () => {
    await clickProjectTab(page, "EDM");
    await waitForW2Table(page);
    const pagination = await exerciseW2Pagination(page, W2_EXPECTED.totalSkus);
    const checkbox = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    await checkbox.check();
    await page.waitForFunction(() => document.querySelector(".si-pagination-count")?.textContent?.includes("/ 80"), null, { timeout: 10_000 });
    const metrics = await readW2TableMetrics(page);
    const rowIds = await page.locator(".si-data-table tbody tr[data-row-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id") ?? ""));
    const childrenVisible = rowIds.some((value) => /-CH-\d{2}$/u.test(value));
    const passed = pagination.passed && metrics.total === W2_EXPECTED.products && await checkbox.isChecked() && !childrenVisible;
    return { passed, evidence: { pagination, parentOnlyTotal: metrics.total, childrenVisible } };
  });

  await attemptW2("Content table renders real packaged rows and advances pagination", "ui", async () => {
    await clickProjectTab(page, "内容");
    await waitForW2Table(page);
    const pagination = await exerciseW2Pagination(page, W2_EXPECTED.blogsBeforeRefresh);
    const refreshButton = page.getByRole("button", { name: "重新抓取", exact: true });
    const refreshVisible = await refreshButton.isVisible();
    const keywordMappingVisible = await page.getByText("关键词映射", { exact: false }).count() > 0;
    return { passed: pagination.passed && refreshVisible && !keywordMappingVisible,
      evidence: { pagination, refreshButtonVisible: refreshVisible, keywordMappingVisible } };
  });

  await attemptW2("Content refresh button runs against loopback-only synthetic pages and refreshes KPI/table", "ui", async () => {
    const refreshButton = page.getByRole("button", { name: "重新抓取", exact: true });
    await refreshButton.click();
    const busyStateObserved = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((item) => ["正在启动…", "抓取中…"].includes(item.textContent?.trim() ?? ""));
      return button?.textContent?.trim() ?? null;
    });
    await page.waitForFunction(async (projectId) => {
      const api = window.siteindex;
      const [summary, blogs] = await Promise.all([
        api.content.summary(projectId),
        api.content.listBlog(projectId, { page: 1, pageSize: 0, filters: {} }),
      ]);
      const value = summary.kpis.find((item) => item.key === "blogs")?.value;
      const noSchema = summary.kpis.find((item) => item.key === "no_schema")?.value;
      return blogs.total === 2 && value === "2" && noSchema === "0";
    }, W2_PROJECT_ID, { timeout: 90_000 });
    await page.waitForFunction(() => document.querySelector(".si-data-table .si-pagination-count")?.textContent?.includes("/ 2"), null, { timeout: 20_000 });
    const uiKpi = await page.locator(".si-content-kpis").innerText();
    const schemaKpi = await page.evaluate(async (projectId) => {
      const summary = await window.siteindex.content.summary(projectId);
      return summary.kpis.find((item) => item.key === "no_schema")?.value ?? null;
    }, W2_PROJECT_ID);
    const table = await readW2TableMetrics(page);
    const requestStats = syntheticSite.metrics();
    const busyStateVisible = busyStateObserved === "正在启动…" || busyStateObserved === "抓取中…";
    const passed = table.total === W2_EXPECTED.blogsAfterRefresh
      && uiKpi.includes("博客文章") && uiKpi.includes(String(W2_EXPECTED.blogsAfterRefresh))
      && schemaKpi === "0"
      && requestStats.requestCount >= 4 && requestStats.failedRequestCount === 0;
    return { passed, evidence: {
      busyStateObserved,
      busyStateVisible,
      refreshedBlogCount: table.total,
      kpiShowsRefreshedCount: uiKpi.includes(String(W2_EXPECTED.blogsAfterRefresh)),
      noSchemaKpi: schemaKpi,
      localRequestCount: requestStats.requestCount,
      failedLocalRequestCount: requestStats.failedRequestCount,
      originRedacted: true,
    } };
  });

  report.w2Acceptance.checks.push({
    name: "Real project and real-site data behavior",
    status: "not-verified",
    evidenceType: "not-verified",
    evidence: { reason: "Hosted acceptance uses synthetic project files and loopback-only pages; no real project was included." },
  });
  await goToW2Route(page, "/");
}

async function safeCandidateScreenshot(page) {
  if (!OUTPUT_DIR) return;
  await mkdir(OUTPUT_DIR, { recursive: true });
  const visibleText = await page.locator("body").innerText();
  const containsRunnerPath = (APP_DATA_ROOT && visibleText.includes(APP_DATA_ROOT)) || visibleText.includes(TEST_ROOT);
  if (containsRunnerPath) {
    report.visualEvidence = { screenshotCreated: false, reason: "synthetic-runner-path-visible" };
    return;
  }
  await page.screenshot({ path: path.join(OUTPUT_DIR, "candidate-synthetic-project-center.png"), fullPage: true });
  report.visualEvidence = { screenshotCreated: true, reason: null };
}

async function testWorkspaceApi(page) {
  const emptyDirectory = path.join(TEST_ROOT, "workspace-create-empty");
  const gitDirectory = path.join(TEST_ROOT, "workspace-create-with-git");
  const nonEmptyDirectory = path.join(TEST_ROOT, "workspace-create-non-empty");
  await mkdir(emptyDirectory, { recursive: true });
  await mkdir(path.join(gitDirectory, ".git"), { recursive: true });
  await mkdir(nonEmptyDirectory, { recursive: true });
  await writeFile(path.join(nonEmptyDirectory, "keep.txt"), "synthetic-user-file\n", "utf8");

  const inputFor = (targetDir, domain) => ({
    targetDir,
    domain,
    brand: { name: "Synthetic Workspace", tagline: "Acceptance fixture only" },
    platform: "woocommerce",
    markets: ["US"],
    esp_presets: [],
  });
  const emptyCheck = await page.evaluate((targetDir) => window.siteindex.workspace.check(targetDir), emptyDirectory);
  assert(emptyCheck.ok, "empty target is accepted", { invalidEntryCount: emptyCheck.invalid_entries.length });
  const emptyResult = await page.evaluate((input) => window.siteindex.workspace.create(input), inputFor(emptyDirectory, "empty.example.invalid"));
  const gitResult = await page.evaluate((input) => window.siteindex.workspace.create(input), inputFor(gitDirectory, "git.example.invalid"));
  const gitPreserved = await exists(path.join(gitDirectory, ".git"));
  assert(gitPreserved, "workspace creation preserves an existing .git directory");

  const nonEmptyResult = await page.evaluate(async (input) => {
    try {
      await window.siteindex.workspace.create(input);
      return { accepted: true, code: null };
    } catch (error) {
      return {
        accepted: false,
        code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
      };
    }
  }, inputFor(nonEmptyDirectory, "nonempty.example.invalid"));
  const nonEmptyErrorCode = nonEmptyResult.code;
  assert(nonEmptyErrorCode === "WORKSPACE_NOT_EMPTY", "non-empty target is rejected without replacing user files", { code: nonEmptyErrorCode });
  assert((await readFile(path.join(nonEmptyDirectory, "keep.txt"), "utf8")) === "synthetic-user-file\n", "existing non-empty target content is unchanged");

  const expectedFiles = ["README.md", "AGENTS.md", "CLAUDE.md", ".env", ".gitignore", "_site-index/workspace.json"];
  const emptyFiles = await Promise.all(expectedFiles.map(async (relative) => exists(path.join(emptyDirectory, relative))));
  const manifest = JSON.parse(await readFile(path.join(emptyDirectory, "_site-index", "workspace.json"), "utf8"));
  const sectionDirectories = await Promise.all(manifest.sections.map(async ({ dir }) => exists(path.join(emptyDirectory, dir))));
  const skillEntries = await readdir(path.join(emptyDirectory, "_site-index", "skills"), { withFileTypes: true });
  const claudeText = await readFile(path.join(emptyDirectory, "CLAUDE.md"), "utf8");
  const generated = emptyFiles.every(Boolean)
    && sectionDirectories.every(Boolean)
    && skillEntries.some((entry) => entry.isDirectory())
    && claudeText.trim() === "@AGENTS.md";
  assert(generated, "workspace template contains required files, sections, installed skills, and rendered CLAUDE.md", {
    requiredFileCount: emptyFiles.filter(Boolean).length,
    sectionCount: sectionDirectories.filter(Boolean).length,
    skillDirectoryCount: skillEntries.filter((entry) => entry.isDirectory()).length,
    claudeContentCorrect: claudeText.trim() === "@AGENTS.md",
    gitWorkspaceCreated: Boolean(gitResult.path),
    emptyWorkspaceCreated: Boolean(emptyResult.path),
  });

  const importInput = {
    url: "https://import.example.invalid",
    brand: { name: "Synthetic Import Project", tagline: "Import preservation fixture" },
    markets: ["US"],
    projects_root: PROJECTS_ROOT,
    folder_name: "synthetic-import-project",
    workspace: { enabled: true, platform: "woocommerce", esp_presets: ["esp.mailchimp"] },
  };
  const { id } = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), importInput);
  const importProjectPath = path.join(PROJECTS_ROOT, id);
  const readmePath = path.join(importProjectPath, "README.md");
  const agentsPath = path.join(importProjectPath, "AGENTS.md");
  const claudePath = path.join(importProjectPath, "CLAUDE.md");
  const envPath = path.join(importProjectPath, ".env");
  const siteConfigPath = path.join(importProjectPath, "_site-index", "site.json");
  const userNotesPath = path.join(importProjectPath, "user-owned-notes.txt");
  const manifestPath = path.join(importProjectPath, "_site-index", "workspace.json");
  const mediaLedgerPath = path.join(importProjectPath, "_site-index", "ledgers", "sku_media.csv");
  const presetPath = path.join(importProjectPath, "_site-index", "skills", "presets", "esp.mailchimp.md");
  const siteConfigBefore = await fileSha256(siteConfigPath);
  const claudeBefore = await readFile(claudePath, "utf8");
  const generatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const presetCopied = generatedManifest.esp_presets.includes("mailchimp") && await exists(presetPath);
  assert(presetCopied, "Mailchimp preset is included in workspace manifest and skill files");
  const workspaceRead = await page.evaluate(async (projectId) => {
    const detail = await window.siteindex.projects.get(projectId);
    return {
      idMatches: detail.summary.id === projectId,
      nameMatches: detail.summary.name === "Synthetic Import Project",
      workspaceSections: detail.config.workspace?.sections?.length ?? 0,
      mailchimpEnabled: detail.config.workspace?.esp_presets?.includes("mailchimp") ?? false,
    };
  }, id);
  assert(workspaceRead.idMatches && workspaceRead.nameMatches && workspaceRead.workspaceSections > 0 && workspaceRead.mailchimpEnabled,
    "packaged projects.get reads workspace layout and selected preset", workspaceRead);
  const removeAutoBlock = (markdown, id) => markdown
    .replace(new RegExp(`<!-- siteindex:auto:start id="${id}" -->[\\s\\S]*?<!-- siteindex:auto:end id="${id}" -->\\s*`, "u"), "")
    .trimEnd() + "\n";
  const readmeBefore = `${removeAutoBlock(await readFile(readmePath, "utf8"), "workspace-map")}\n<!-- synthetic-user-area -->\nPreserve this user section.\n`;
  const agentsBefore = `${removeAutoBlock(await readFile(agentsPath, "utf8"), "agents-core")}\n<!-- synthetic-agent-user-area -->\nPreserve this agent section.\n`;
  const envBefore = "SYNTHETIC_ACCEPTANCE=preserve-this-value\n";
  const userNotesBefore = "Synthetic user-authored file: preserve byte-for-byte.\n";
  await writeFile(readmePath, readmeBefore, "utf8");
  await writeFile(agentsPath, agentsBefore, "utf8");
  await writeFile(envPath, envBefore, "utf8");
  await writeFile(userNotesPath, userNotesBefore, "utf8");
  await rm(manifestPath, { force: true });
  await rm(mediaLedgerPath, { force: true });
  const importResult = await page.evaluate((projectId) => window.siteindex.workspace.importCheck(projectId, { apply: true }), id);
  const readmeAfter = await readFile(readmePath, "utf8");
  const agentsAfter = await readFile(agentsPath, "utf8");
  const claudeAfter = await readFile(claudePath, "utf8");
  const envAfter = await readFile(envPath, "utf8");
  const userNotesAfter = await readFile(userNotesPath, "utf8");
  const siteConfigAfter = await fileSha256(siteConfigPath);
  assert(importResult.repaired.length >= 4, "import check repairs missing manifest, ledger, and required auto blocks", {
    repairedCount: importResult.repaired.length,
    readmeAutoBlockRepaired: importResult.repaired.includes("README.md"),
    agentsAutoBlockRepaired: importResult.repaired.includes("AGENTS.md"),
  });
  const readmeAutoBlockRestored = /<!-- siteindex:auto:start id="workspace-map" -->[\s\S]*?<!-- siteindex:auto:end id="workspace-map" -->/u.test(readmeAfter);
  const agentsAutoBlockRestored = /<!-- siteindex:auto:start id="agents-core" -->[\s\S]*?<!-- siteindex:auto:end id="agents-core" -->/u.test(agentsAfter);
  const userContentKeptAroundAutoBlocks = readmeAfter.startsWith(readmeBefore) && agentsAfter.startsWith(agentsBefore);
  assert(readmeAutoBlockRestored && agentsAutoBlockRestored && userContentKeptAroundAutoBlocks,
    "import check adds only missing README and AGENTS auto blocks while preserving user sections", {
      readmeAutoBlockRestored,
      agentsAutoBlockRestored,
      readmeUserAreaPreserved: readmeAfter.includes("Preserve this user section."),
      agentUserAreaPreserved: agentsAfter.includes("Preserve this agent section."),
      userContentKeptAroundAutoBlocks,
    });
  const userFilesPreserved = readmeAfter.includes("Preserve this user section.")
    && agentsAfter.includes("Preserve this agent section.")
    && claudeAfter === claudeBefore
    && envAfter === envBefore
    && userNotesAfter === userNotesBefore;
  assert(userFilesPreserved && siteConfigAfter === siteConfigBefore,
    "import check preserves README user area, .env, user file, and site.json", {
    userAreaPreserved: readmeAfter.includes("Preserve this user section."),
    agentUserAreaPreserved: agentsAfter.includes("Preserve this agent section."),
    existingClaudeFilePreserved: claudeAfter === claudeBefore,
    envPreserved: envAfter === envBefore,
    userFilePreserved: userNotesAfter === userNotesBefore,
    siteConfigPreserved: siteConfigAfter === siteConfigBefore,
  });

  await page.evaluate(async (projectId) => {
    await window.siteindex.projects.updateConfig(projectId, {
      brand: { name: "Synthetic Updated Brand", tagline: "Refresh check" },
    });
    await window.siteindex.readme.refresh(projectId);
  }, id);
  const refreshedAgents = await readFile(agentsPath, "utf8");
  const readmeAutoBlocksRefreshed = refreshedAgents.includes("Synthetic Updated Brand")
    && refreshedAgents.includes("Preserve this agent section.")
    && (await readFile(readmePath, "utf8")).includes("Preserve this user section.");
  assert(readmeAutoBlocksRefreshed, "README and AGENTS auto blocks refresh without removing user areas");

  await Promise.all([readmePath, agentsPath, claudePath].map((file) => rm(file, { force: true })));
  const missingDocsPreview = await page.evaluate((projectId) => window.siteindex.workspace.importCheck(projectId), id);
  const missingDocsResult = await page.evaluate((projectId) => window.siteindex.workspace.importCheck(projectId, { apply: true }), id);
  const readmeRestored = await exists(readmePath);
  const agentsRestored = await exists(agentsPath);
  const claudeRestored = await exists(claudePath);
  const restoredReadme = readmeRestored ? await readFile(readmePath, "utf8") : "";
  const restoredAgents = agentsRestored ? await readFile(agentsPath, "utf8") : "";
  const restoredClaude = claudeRestored ? (await readFile(claudePath, "utf8")).trim() : null;
  const missingIssueFor = (relativePath) => missingDocsPreview.issues.find((issue) => issue.path === relativePath && issue.code === "document_missing");
  const readmeMissingIssue = missingIssueFor("README.md");
  const agentsMissingIssue = missingIssueFor("AGENTS.md");
  const claudeMissingIssue = missingIssueFor("CLAUDE.md");
  const claudeMissingReported = Boolean(claudeMissingIssue);
  const restoredReadmeBlocks = ["workspace-map", "index-summary", "changelog"].every((block) =>
    new RegExp(`<!-- siteindex:auto:start id="${block}" -->[\\s\\S]*?<!-- siteindex:auto:end id="${block}" -->`, "u").test(restoredReadme));
  const restoredAgentBlocks = ["agents-core", "task-routing", "data-guide", "design-summary", "skills-installed", "esp-presets"].every((block) =>
    new RegExp(`<!-- siteindex:auto:start id="${block}" -->[\\s\\S]*?<!-- siteindex:auto:end id="${block}" -->`, "u").test(restoredAgents));
  const readmeRepaired = missingDocsResult.repaired.includes("README.md");
  const agentsRepaired = missingDocsResult.repaired.includes("AGENTS.md");
  const claudeRepaired = missingDocsResult.repaired.includes("CLAUDE.md");
  const missingDocumentChecks = [
    {
      name: "import check detects and restores missing README.md from template",
      passed: readmeMissingIssue?.auto_fixable === true && readmeRepaired && readmeRestored && restoredReadmeBlocks,
      evidence: {
        reportedMissingBeforeApply: Boolean(readmeMissingIssue),
        autoFixableBeforeApply: readmeMissingIssue?.auto_fixable === true,
        repairedByApply: readmeRepaired,
        restored: readmeRestored,
        requiredAutoBlocksPresent: restoredReadmeBlocks,
      },
    },
    {
      name: "import check detects and restores missing AGENTS.md from template",
      passed: agentsMissingIssue?.auto_fixable === true && agentsRepaired && agentsRestored && restoredAgentBlocks,
      evidence: {
        reportedMissingBeforeApply: Boolean(agentsMissingIssue),
        autoFixableBeforeApply: agentsMissingIssue?.auto_fixable === true,
        repairedByApply: agentsRepaired,
        restored: agentsRestored,
        requiredAutoBlocksPresent: restoredAgentBlocks,
      },
    },
    {
      name: "import check detects and restores missing CLAUDE.md as @AGENTS.md",
      passed: claudeMissingIssue?.auto_fixable === true && claudeRepaired && claudeRestored && restoredClaude === "@AGENTS.md",
      evidence: {
        reportedMissingBeforeApply: claudeMissingReported,
        autoFixableBeforeApply: claudeMissingIssue?.auto_fixable === true,
        repairedByApply: claudeRepaired,
        restored: claudeRestored,
        contentCorrect: restoredClaude === "@AGENTS.md",
      },
    },
  ];
  report.checks.push(...missingDocumentChecks.map(({ name, passed, evidence }) => ({ name, status: passed ? "passed" : "failed", evidence })));
  const missingDocsSummary = {
    previewIssuePaths: missingDocsPreview.issues.map((issue) => ({ path: issue.path, code: issue.code, autoFixable: issue.auto_fixable })),
    repairedPaths: missingDocsResult.repaired,
    readmeMissingReported: Boolean(readmeMissingIssue),
    readmeRepaired,
    readmeRestored,
    readmeRequiredAutoBlocksPresent: restoredReadmeBlocks,
    agentsMissingReported: Boolean(agentsMissingIssue),
    agentsRepaired,
    agentsRestored,
    agentsRequiredAutoBlocksPresent: restoredAgentBlocks,
    claudeRepaired,
    claudeRestored,
    claudeContentCorrect: restoredClaude === "@AGENTS.md",
    claudeMissingReported,
  };
  const missingDocsPassed = missingDocumentChecks.every((check) => check.passed);

  const restoredDocumentHashes = await Promise.all([readmePath, agentsPath, claudePath].map(fileSha256));
  const siteConfigAfterMissingDocCheck = await fileSha256(siteConfigPath);
  const noMissingFilesApply = await page.evaluate((projectId) => window.siteindex.workspace.importCheck(projectId, { apply: true }), id);
  const restoredDocumentHashesAfter = await Promise.all([readmePath, agentsPath, claudePath].map(fileSha256));
  const fillMissingOnly = JSON.stringify(restoredDocumentHashes) === JSON.stringify(restoredDocumentHashesAfter)
    && siteConfigAfterMissingDocCheck === await fileSha256(siteConfigPath)
    && noMissingFilesApply.repaired.length === 0;
  const fillMissingOnlyEvidence = {
    existingDocumentsUnchanged: JSON.stringify(restoredDocumentHashes) === JSON.stringify(restoredDocumentHashesAfter),
    siteConfigUnchanged: siteConfigAfterMissingDocCheck === await fileSha256(siteConfigPath),
    repairedCountOnSecondApply: noMissingFilesApply.repaired.length,
  };
  report.checks.push({
    name: "a second import check leaves restored documents and existing project data unchanged",
    status: fillMissingOnly ? "passed" : "failed",
    evidence: fillMissingOnlyEvidence,
  });

  workspaceProbeData = {
    emptyWorkspaceCreated: true,
    gitDirectoryAccepted: true,
    nonEmptyTargetRejected: true,
    requiredFiles: emptyFiles.filter(Boolean).length,
    requiredSections: sectionDirectories.filter(Boolean).length,
    importRepairedFiles: importResult.repaired.length,
    mailchimpEnabled: presetCopied && workspaceRead.mailchimpEnabled,
    siteConfigPreserved: siteConfigAfter === siteConfigBefore,
    userFilesPreserved,
    readmeAutoBlocksRefreshed,
    userContentPreserved: userFilesPreserved && siteConfigAfter === siteConfigBefore,
    missingDocuments: missingDocsSummary,
    userContentPreservedWhenAutoBlocksRepaired: userContentKeptAroundAutoBlocks,
    repeatedImportOnlyFillsMissingFiles: fillMissingOnly,
  };
  if (!missingDocsPassed || !fillMissingOnly) {
    throw new Error("Acceptance assertion failed: import check must restore missing workspace documents without overwriting existing content");
  }
}

async function captureAddExistingTrace(page) {
  const timedProjectPath = path.join(TEST_ROOT, "synthetic-add-existing");
  const workspaceInput = {
    targetDir: timedProjectPath,
    domain: "timed.example.invalid",
    brand: { name: "Synthetic Timed Project", tagline: "Performance fixture" },
    platform: "woocommerce",
    markets: ["US"],
    esp_presets: [],
  };
  await page.evaluate((input) => window.siteindex.workspace.create(input), workspaceInput);
  const siteConfigPath = path.join(timedProjectPath, "_site-index", "site.json");
  const siteConfig = JSON.parse(await readFile(siteConfigPath, "utf8"));
  siteConfig.schedule = disabledSchedule();
  await writeFile(siteConfigPath, `${JSON.stringify(siteConfig, null, 2)}\n`, "utf8");
  for (const root of await traceRoots()) {
    for (const traceFile of await findTraceLogs(root)) await rm(traceFile, { force: true });
  }
  report.addExistingTrace = {
    traceEnvPassedToSpawn: report.traceEnvironmentPassedToSpawn,
    traceSearchRootCount: null,
    logFileFound: false,
    logLocations: [],
    phases: [],
    targetMs: 5000,
  };
  const project = await page.evaluate((target) => window.siteindex.projects.addExisting(target), timedProjectPath);
  assert(project && typeof project.id === "string", "projects.addExisting registers synthetic project via packaged IPC");

  const deadline = Date.now() + 30_000;
  let trace = "";
  let traceSearchRootCount = 0;
  let traceFileCount = 0;
  let traceLocations = [];
  while (Date.now() < deadline) {
    const current = await readTraceLogs();
    trace = current.text;
    traceSearchRootCount = current.rootCount;
    traceFileCount = current.fileCount;
    traceLocations = current.locations;
    if (
      trace.includes("projects.addExisting handler.total")
      && trace.includes("projects.addExisting scheduler.task_list")
      && trace.includes("projects.addExisting scheduler.task_query")
    ) break;
    await delay(200);
  }
  const entries = [...trace.matchAll(/^projects\.addExisting ([a-z_.]+) ([\d.]+)ms$/gmu)]
    .map(([, phase, duration]) => ({ phase, durationMs: Number(duration) }));
  const handlerTotalMs = entries.find((entry) => entry.phase === "handler.total")?.durationMs ?? null;
  report.addExistingTrace = {
    traceEnvPassedToSpawn: report.traceEnvironmentPassedToSpawn,
    traceSearchRootCount,
    logFileFound: traceFileCount > 0,
    traceLogFileCount: traceFileCount,
    logLocations: traceLocations,
    phaseCount: entries.length,
    phases: entries,
    handlerTotalMs,
    targetMs: 5000,
    withinTarget: handlerTotalMs !== null && handlerTotalMs < 5000,
    elevationWaitRecorded: entries.some((entry) => entry.phase === "scheduler.elevation_wait"),
  };
  assert(handlerTotalMs !== null, "SITEINDEX_TRACE records add-existing handler total", { tracePhaseCount: entries.length });
  assert(handlerTotalMs < 5000, "add-existing handler total is under five seconds", { handlerTotalMs });
  assert(
    entries.some((entry) => entry.phase === "scheduler.task_list")
      && entries.some((entry) => entry.phase === "scheduler.task_query"),
    "SITEINDEX_TRACE records task-list and XML-query phases",
    { taskListRecorded: entries.some((entry) => entry.phase === "scheduler.task_list"), taskQueryRecorded: entries.some((entry) => entry.phase === "scheduler.task_query") },
  );
}

async function main() {
  if (process.platform !== "win32") throw new Error("This acceptance workflow requires Windows.");
  if (!OUTPUT_DIR) throw new Error("SITEINDEX_ACCEPTANCE_OUTPUT is not configured.");
  if (!APP_DATA_ROOT) throw new Error("APPDATA is unavailable on this Windows runner.");
  if (hasInstalledSiteIndex()) throw new Error("The Windows runner already has a SiteIndex install; refusing to touch it.");
  if (await exists(APP_DATA_DIR)) throw new Error("The Windows runner already has SiteIndex user data; refusing to alter it.");
  const oldInstaller = path.resolve(process.argv[2] || "");
  const candidateInstaller = path.resolve(process.argv[3] || "");
  if (!oldInstaller || !candidateInstaller || !(await exists(oldInstaller)) || !(await exists(candidateInstaller))) {
    throw new Error("The official and candidate installers must both exist.");
  }
  const actualOldHash = await fileSha256(oldInstaller);
  assert(actualOldHash === OLD_RELEASE.sha256, "official v0.3.0 installer matches pinned GitHub digest", { tag: OLD_RELEASE.tag, sha256: actualOldHash });
  report.candidateInstallerSha256 = await fileSha256(candidateInstaller);
  report.sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const expectedCandidateHash = process.env.SITEINDEX_EXPECTED_CANDIDATE_SHA256?.trim().toLowerCase();
  if (report.candidateArtifactSource === "workflow-run-artifact") {
    assert(
      report.candidateArtifactName === "siteindex-win"
        && report.candidateWorkflowRunId !== null
        && report.candidateArtifactId !== null
        && report.candidateSourceCommit === report.expectedCandidateSourceCommit
        && report.candidateArtifactSha256 === report.expectedCandidateArtifactSha256,
      "candidate installer provenance matches the verified Windows workflow artifact",
      {
        artifactName: report.candidateArtifactName,
        artifactId: report.candidateArtifactId,
        runId: report.candidateWorkflowRunId,
        artifactDigestMatches: report.candidateArtifactSha256 === report.expectedCandidateArtifactSha256,
        sourceCommitMatches: report.candidateSourceCommit === report.expectedCandidateSourceCommit,
      },
    );
  }
  if (report.expectedSourceCommit) {
    assert(report.sourceCommit === report.expectedSourceCommit, "checkout matches requested frozen source commit", {
      expectedCommit: report.expectedSourceCommit,
      sourceCommit: report.sourceCommit,
    });
  }
  if (expectedCandidateHash) {
    assert(report.candidateInstallerSha256 === expectedCandidateHash, "candidate installer matches supplied official SHA256", {
      sha256: report.candidateInstallerSha256,
    });
  }

  await mkdir(PROJECTS_ROOT, { recursive: true });
  const legacyProjectPath = path.join(PROJECTS_ROOT, "synthetic-legacy-project");
  await makeLegacyProject(legacyProjectPath);
  const projectSnapshot = await snapshotTree(legacyProjectPath);
  currentStage = "v0.3.0 installation";
  await install(oldInstaller);
  assert(await exists(path.join(INSTALL_DIR, "SiteIndex.exe")), "v0.3.0 installed into dedicated runner directory");
  await writeRunnerSettings();

  currentStage = "v0.3.0 packaged launch";
  let page = await launchInstalledApp({ executablePath: path.join(INSTALL_DIR, "SiteIndex.exe") });
  const oldState = await appState(page);
  assert(oldState.version === "0.3.0", "old packaged app reports v0.3.0 through preload IPC", { version: oldState.version });
  assert(oldState.projectIds.includes("synthetic-legacy-project") && oldState.projectCount === 1, "v0.3.0 discovers synthetic legacy project", {
    projectCount: oldState.projectCount,
    syntheticProjectFound: oldState.projectIds.includes("synthetic-legacy-project"),
    syntheticSkuCount: oldState.activeSkuCounts[0] ?? 0,
  });
  assert(oldState.settings.projects_root === PROJECTS_ROOT, "v0.3.0 loads project-root setting from the runner's default profile");
  const oldSettings = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  await stopApplication();

  currentStage = "candidate upgrade installation";
  await install(candidateInstaller);
  candidateInstalled = true;
  assert(await exists(path.join(INSTALL_DIR, "SiteIndex.exe")), "candidate installer upgraded the same installation directory");

  currentStage = `v${CANDIDATE_VERSION} packaged launch and upgrade persistence`;
  page = await launchInstalledApp({ executablePath: path.join(INSTALL_DIR, "SiteIndex.exe"), trace: true });
  const syntheticSite = await startSyntheticSite();
  report.w2Acceptance.seed = await makeW2SyntheticProject(path.join(PROJECTS_ROOT, W2_PROJECT_ID), syntheticSite.origin);
  const candidateState = await appState(page);
  assert(candidateState.version === CANDIDATE_VERSION, "upgraded packaged app reports candidate version through preload IPC", { version: candidateState.version });
  assert(candidateState.projectIds.includes("synthetic-legacy-project")
    && candidateState.projectIds.includes(W2_PROJECT_ID)
    && candidateState.projectCount === 2, "synthetic legacy and W2 projects are listed by the upgraded package", {
    projectCount: candidateState.projectCount,
    legacyProjectFound: candidateState.projectIds.includes("synthetic-legacy-project"),
    w2SyntheticProjectFound: candidateState.projectIds.includes(W2_PROJECT_ID),
  });
  const legacyRead = await page.evaluate(async () => {
    const detail = await window.siteindex.projects.get("synthetic-legacy-project");
    return {
      idMatches: detail.summary.id === "synthetic-legacy-project",
      name: detail.summary.name,
      domain: detail.config.domain,
      skuCount: detail.summary.sku_count,
      legacyLayout: !detail.config.workspace,
    };
  });
  assert(legacyRead.idMatches && legacyRead.name === "Synthetic legacy project" && legacyRead.domain === "legacy.example.invalid"
    && legacyRead.skuCount === 1 && legacyRead.legacyLayout, "packaged projects.get reads legacy project and synthetic index data", {
    idMatches: legacyRead.idMatches,
    syntheticName: legacyRead.name === "Synthetic legacy project",
    domainIsSynthetic: legacyRead.domain === "legacy.example.invalid",
    skuCount: legacyRead.skuCount,
    legacyLayout: legacyRead.legacyLayout,
  });
  const settingsAfterUpgrade = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  const settingsPreserved = settingsAfterUpgrade.projects_root === PROJECTS_ROOT
    && settingsAfterUpgrade.device_id === oldSettings.device_id
    && settingsAfterUpgrade.cache_dir === oldSettings.cache_dir
    && settingsAfterUpgrade.browser.channel === oldSettings.browser.channel
    && settingsAfterUpgrade.notify.on_success === oldSettings.notify.on_success;
  assert(settingsPreserved, "settings values persist across in-place upgrade", {
    projectRootPreserved: settingsAfterUpgrade.projects_root === PROJECTS_ROOT,
    deviceIdPreserved: settingsAfterUpgrade.device_id === oldSettings.device_id,
    cacheDirectoryPreserved: settingsAfterUpgrade.cache_dir === oldSettings.cache_dir,
    browserChannelPreserved: settingsAfterUpgrade.browser.channel === oldSettings.browser.channel,
    notificationSettingPreserved: settingsAfterUpgrade.notify.on_success === oldSettings.notify.on_success,
  });
  const projectDataUnchanged = JSON.stringify(await snapshotTree(legacyProjectPath)) === JSON.stringify(projectSnapshot);
  assert(projectDataUnchanged, "synthetic legacy project files are byte-identical after upgrade");

  currentStage = "SITEINDEX_TRACE add-existing measurement";
  await captureAddExistingTrace(page);
  currentStage = "packaged workspace IPC acceptance";
  await testWorkspaceApi(page);
  currentStage = "packaged W2 page acceptance";
  await testW2Pages(page, syntheticSite);
  const finalState = await appState(page);
  assert(finalState.version === CANDIDATE_VERSION && finalState.projectCount >= 4
    && finalState.projectIds.includes(W2_PROJECT_ID), "candidate project center lists the legacy, W2, add-existing, and workspace projects", {
    projectCount: finalState.projectCount,
    syntheticLegacyPresent: finalState.projectIds.includes("synthetic-legacy-project"),
    w2SyntheticProjectPresent: finalState.projectIds.includes(W2_PROJECT_ID),
  });
  await safeCandidateScreenshot(page);
}

async function uninstallCurrent() {
  const uninstaller = path.join(INSTALL_DIR, "Uninstall SiteIndex.exe");
  if (await exists(uninstaller)) {
    run(uninstaller, ["/S", `_?=${INSTALL_DIR}`], { timeout: 300_000 });
  }
}

async function writeReport() {
  if (!OUTPUT_DIR) return;
  await mkdir(OUTPUT_DIR, { recursive: true });
  report.workspaceAcceptance = workspaceProbeData;
  const w2Failures = report.w2Acceptance.checks.filter((check) => check.status === "failed").length;
  const w2NotVerified = report.w2Acceptance.checks.filter((check) => check.status === "not-verified").length;
  report.w2Acceptance.summary = {
    passed: report.w2Acceptance.checks.filter((check) => check.status === "passed").length,
    failed: w2Failures,
    notVerified: w2NotVerified,
  };
  report.result = failed || w2Failures > 0 ? "failed" : "passed";
  if (failed) report.failure = failed;
  await writeFile(path.join(OUTPUT_DIR, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summaryLines = [
    `## E · Windows ${OLD_RELEASE.tag} → v${CANDIDATE_VERSION} isolated packaged acceptance`,
    "",
    `- Result: **${report.result}**`,
    `- Source commit: \`${report.sourceCommit ?? "unavailable"}\``,
    `- Candidate artifact: ${report.candidateArtifactSource}`,
    `- Candidate source commit: \`${report.candidateSourceCommit ?? "unavailable"}\``,
    `- Candidate workflow run / artifact: \`${report.candidateWorkflowRunId ?? "n/a"}\` / \`${report.candidateArtifactId ?? "n/a"}\``,
    `- Candidate artifact SHA256: \`${report.candidateArtifactSha256 ?? "n/a"}\``,
    `- Candidate installer SHA256: \`${report.candidateInstallerSha256 ?? "unavailable"}\``,
    `- Windows build: \`${report.windows.build ?? report.windows.version}\``,
    `- Checks passed: ${report.checks.filter((check) => check.status === "passed").length}/${report.checks.length}`,
    `- Add-existing handler total: ${report.addExistingTrace?.handlerTotalMs ?? "not measured"} ms (target < 5000 ms)`,
    `- Screenshot: ${report.visualEvidence?.screenshotCreated ? "created" : report.visualEvidence?.reason ?? "not available"}`,
    "- Data: synthetic runner-only project; no real project or customer data used.",
    "",
    `### W2 packaged page acceptance: ${report.w2Acceptance.summary.passed} passed, ${report.w2Acceptance.summary.failed} failed, ${report.w2Acceptance.summary.notVerified} not verified`,
    "",
    ...report.w2Acceptance.checks.map((check) => `- ${check.status.toUpperCase()} · ${check.evidenceType} · ${check.name}`),
    "",
    "### Not covered by this runner",
    ...report.uncovered.map((item) => `- ${item}`),
  ];
  if (failed) summaryLines.push(`- Failure stage: ${failed.stage} (${failed.reason})`);
  await writeFile(path.join(OUTPUT_DIR, "summary.md"), `${summaryLines.join("\n")}\n`, "utf8");
}

try {
  await main();
} catch (error) {
  failed = {
    stage: currentStage,
    code: error && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION_OR_RUNTIME_FAILURE",
    reason: safeMessage(error),
  };
  console.error(`Windows v0.4 acceptance failed at ${currentStage}: ${safeMessage(error)}`);
} finally {
  await stopApplication();
  try {
    await closeSyntheticSite();
  } catch (error) {
    failed ??= { stage: "cleanup", code: "SYNTHETIC_SITE_CLEANUP_FAILED", reason: safeMessage(error) };
  }
  try {
    if (candidateInstalled || await exists(path.join(INSTALL_DIR, "Uninstall SiteIndex.exe"))) await uninstallCurrent();
  } catch (error) {
    failed ??= { stage: "cleanup", code: "UNINSTALL_FAILED", reason: safeMessage(error) };
  }
  if (testProfileCreated) {
    try {
      await rm(APP_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      failed ??= { stage: "cleanup", code: "PROFILE_CLEANUP_FAILED", reason: safeMessage(error) };
    }
  }
  try {
    await rm(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (error) {
    failed ??= { stage: "cleanup", code: "TEST_DATA_CLEANUP_FAILED", reason: safeMessage(error) };
  }
  await writeReport();
}

if (failed || report.w2Acceptance.checks.some((check) => check.status === "failed")) process.exitCode = 1;
