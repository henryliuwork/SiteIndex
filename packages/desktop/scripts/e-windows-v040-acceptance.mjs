import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat as statFile,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { waitForUpdatedWindowsApp } from "./e-windows-v041-reconnect.mjs";
import { makeW2SyntheticFixture, W2_SYNTHETIC_EXPECTED } from "./e-windows-v040-synthetic-fixture.mjs";

const OLD_RELEASE = {
  version: process.env.SITEINDEX_BASELINE_VERSION?.trim() || "0.4.0",
  tag: `v${process.env.SITEINDEX_BASELINE_VERSION?.trim() || "0.4.0"}`,
  commit: process.env.SITEINDEX_BASELINE_TAG_COMMIT?.trim() || "334d5bee76156ad856986031020f51b2bcb7319d",
  assetId: process.env.SITEINDEX_BASELINE_ASSET_ID?.trim() || "734250277",
  sha256: process.env.SITEINDEX_BASELINE_ASSET_SHA256?.trim().toLowerCase()
    || "a7414e062a18170ef00f3bb7e09d11cb2b81d2197baff8717b7ee4a9ddda2b90",
};
const CANDIDATE_VERSION = process.env.SITEINDEX_CANDIDATE_VERSION?.trim() || "0.4.1";
const HOSTED_UPDATE = process.env.SITEINDEX_HOSTED_UPDATE === "true";
const W2_PROJECT_ID = "synthetic-w2-pages";
const W2_EXPECTED = W2_SYNTHETIC_EXPECTED;
const CDP_PORT = 9333;
const OUTPUT_DIR = process.env.SITEINDEX_ACCEPTANCE_OUTPUT;
const TEST_ROOT = await fsMkdtemp();
const APP_DATA_ROOT = process.env.APPDATA;
const LOCAL_APP_DATA_ROOT = path.join(TEST_ROOT, "local-app-data");
const PROJECTS_ROOT = path.join(TEST_ROOT, "projects");
const W2_PROJECT_DIRECTORY = path.join(PROJECTS_ROOT, W2_PROJECT_ID);
const INSTALL_DIR = path.join(TEST_ROOT, "installed-app");
const APP_DATA_DIR = APP_DATA_ROOT ? path.join(APP_DATA_ROOT, "SiteIndex") : "";
const SETTINGS_FILE = APP_DATA_DIR ? path.join(APP_DATA_DIR, "settings.json") : "";
const TRACE_LOG_NAME = "siteindex-trace.log";
const TRACE_SEARCH_ROOTS = [
  APP_DATA_DIR,
  APP_DATA_ROOT ? path.join(APP_DATA_ROOT, "siteindex-desktop") : "",
  path.join(LOCAL_APP_DATA_ROOT, "SiteIndex"),
  path.join(LOCAL_APP_DATA_ROOT, "siteindex"),
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
  hostedUpdate: HOSTED_UPDATE,
  userDataIsolation: "ephemeral GitHub runner APPDATA with a clean per-run SiteIndex directory; isolated temporary LOCALAPPDATA vault",
  candidateReleaseCommit: process.env.SITEINDEX_CANDIDATE_RELEASE_COMMIT || null,
  candidateReleaseAssetId: process.env.SITEINDEX_CANDIDATE_RELEASE_ASSET_ID || null,
  candidateReleaseAssetSha256: process.env.SITEINDEX_CANDIDATE_RELEASE_ASSET_SHA256 || null,
  candidateReleaseWorkflowRunId: process.env.SITEINDEX_CANDIDATE_RELEASE_RUN_ID || null,
  candidateReleaseArtifactId: process.env.SITEINDEX_CANDIDATE_RELEASE_ARTIFACT_ID || null,
  candidateReleaseArtifactSha256: process.env.SITEINDEX_CANDIDATE_RELEASE_ARTIFACT_SHA256 || null,
  candidateReleaseArtifactExeSha256: process.env.SITEINDEX_CANDIDATE_RELEASE_ARTIFACT_EXE_SHA256 || null,
  candidateUpdateMetadataVerified: process.env.SITEINDEX_CANDIDATE_UPDATE_METADATA_VERIFIED === "true",
  updateMode: HOSTED_UPDATE ? "published-github-release" : "candidate-installer",
  updaterRestart: {
    detected: false,
    hadRemoteDebugPort: false,
    harnessRelaunchedForIpc: false,
    originalRestartProfile: "not-applicable",
    harnessProfileVerified: false,
    executableVersion: null,
  },
  runnerBuildVersionOverride: process.env.SITEINDEX_CANDIDATE_ARTIFACT_SOURCE === "runner-built-internal-candidate",
  previousRelease: { ...OLD_RELEASE },
  candidateInstallerSha256: null,
  installerStartedAppBeforeHarness: null,
  windows: {
    version: process.env.SITEINDEX_WINDOWS_VERSION || os.version(),
    build: process.env.SITEINDEX_WINDOWS_BUILD || null,
    runnerImage: process.env.SITEINDEX_RUNNER_IMAGE || "windows-2025",
    architecture: os.arch(),
  },
  checks: [],
  processOutput: [],
  rendererDiagnostics: { targets: [], consoleErrors: [], pageErrors: [] },
  addExistingTrace: null,
  traceEnvironmentPassedToSpawn: false,
  visualEvidence: null,
  w2Acceptance: {
    candidateVersion: CANDIDATE_VERSION,
    candidateArtifactSource: process.env.SITEINDEX_CANDIDATE_ARTIFACT_SOURCE || "runner-built-internal-candidate",
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
let w2RuntimeDiagnostics = [];
let activeW2CheckNumber = null;
const instrumentedPages = new WeakSet();

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

function stopInstalledAppProcesses() {
  const stopInstalledApp = [
    "$installDir = [System.IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_DIR)",
    "$installedExe = Join-Path $installDir 'SiteIndex.exe'",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'SiteIndex.exe' -and $_.ExecutablePath -ieq $installedExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopInstalledApp], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, SITEINDEX_ACCEPTANCE_INSTALL_DIR: INSTALL_DIR },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not stop only the SiteIndex process from the isolated acceptance install.");
}

function installedAppProcessCount() {
  const command = [
    "$installDir = [System.IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_DIR)",
    "$installedExe = Join-Path $installDir 'SiteIndex.exe'",
    "$count = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'SiteIndex.exe' -and $_.ExecutablePath -ieq $installedExe }).Count",
    "Write-Output $count",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, SITEINDEX_ACCEPTANCE_INSTALL_DIR: INSTALL_DIR },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

function installedExecutableVersion() {
  const command = [
    "$exe = Join-Path ([System.IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_INSTALL_DIR)) 'SiteIndex.exe'",
    "if (Test-Path -LiteralPath $exe -PathType Leaf) { (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, SITEINDEX_ACCEPTANCE_INSTALL_DIR: INSTALL_DIR },
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function collectProcessOutput(stream, chunk) {
  const lines = chunk.toString("utf8").split(/\r?\n/u).filter(Boolean);
  for (const line of lines) report.processOutput.push({ stream, text: safeMessage(line).slice(0, 600) });
  if (report.processOutput.length > 40) report.processOutput.splice(0, report.processOutput.length - 40);
}

async function writeRunnerSettings() {
  await mkdir(APP_DATA_DIR, { recursive: true });
  await mkdir(LOCAL_APP_DATA_ROOT, { recursive: true });
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
  const environment = {
    ...process.env,
    APPDATA: APP_DATA_ROOT,
    LOCALAPPDATA: LOCAL_APP_DATA_ROOT,
    ELECTRON_RENDERER_URL: "",
    SITEINDEX_UI_URL: "",
  };
  if (HOSTED_UPDATE && process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Hosted update acceptance must run on a fresh GitHub Actions Windows runner.");
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    delete environment[key];
  }
  if (trace) environment.SITEINDEX_TRACE = "1";
  else delete environment.SITEINDEX_TRACE;
  report.traceEnvironmentPassedToSpawn = trace && environment.SITEINDEX_TRACE === "1";
  applicationProcess = spawn(executablePath, [`--remote-debugging-port=${CDP_PORT}`, "--disable-gpu"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  applicationProcess.on("error", () => undefined);
  applicationProcess.stdout?.on("data", (chunk) => collectProcessOutput("stdout", chunk));
  applicationProcess.stderr?.on("data", (chunk) => collectProcessOutput("stderr", chunk));
  return connectToInstalledApp({ processHandle: applicationProcess });
}

async function connectToInstalledApp({ processHandle = null } = {}) {
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
    if (processHandle && processHandle.exitCode !== null) throw new Error("Packaged SiteIndex process exited before CDP became ready.");
    await delay(500);
  }
  if (Date.now() >= deadline) throw new Error(lastError ? "Packaged SiteIndex CDP endpoint did not start." : "Packaged SiteIndex CDP timed out.");

  browserConnection = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
  const deadlineForPage = Date.now() + 60_000;
  let page = null;
  while (Date.now() < deadlineForPage) {
    const pages = browserConnection.contexts().flatMap((context) => context.pages());
    for (const candidate of pages) {
      if (instrumentedPages.has(candidate)) continue;
      instrumentedPages.add(candidate);
      candidate.on("console", (message) => {
        if (message.type() === "error") report.rendererDiagnostics.consoleErrors.push(safeMessage(message.text()).slice(0, 600));
      });
      candidate.on("pageerror", (error) => report.rendererDiagnostics.pageErrors.push(safeMessage(error).slice(0, 600)));
    }
    page = pages.find((candidate) => candidate.url().startsWith("file:") && candidate.url().includes("/ui/index.html")) ?? null;
    if (page) break;
    if (processHandle && processHandle.exitCode !== null) throw new Error("Packaged SiteIndex process exited before its UI target appeared.");
    await delay(300);
  }
  if (!page) {
    report.rendererDiagnostics.targets = await Promise.all(
      browserConnection.contexts().flatMap((context) => context.pages()).map(async (target) => ({
        url: safeMessage(target.url()),
        title: safeMessage(await target.title().catch(() => "")),
      })),
    );
    throw new Error(`Packaged app did not load the complete file-based UI page; CDP targets=${JSON.stringify(report.rendererDiagnostics.targets)}`);
  }
  await page.waitForFunction(() => typeof window.siteindex === "object" && window.siteindex !== null, null, { timeout: 30_000 });
  await delay(300);
  if (processHandle && processHandle.exitCode !== null) throw new Error("Packaged app process exited after CDP attached; refusing to use another app instance.");
  return page;
}

async function waitForHostedUpdatedApp() {
  const result = await waitForUpdatedWindowsApp({
    candidateVersion: CANDIDATE_VERSION,
    connectExisting: async () => {
      const endpoint = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).catch(() => null);
      if (!endpoint?.ok) return null;
      if (browserConnection) {
        await browserConnection.close().catch(() => undefined);
        browserConnection = null;
      }
      try {
        const page = await connectToInstalledApp();
        const state = await appState(page);
        return { page, version: state.version };
      } catch (error) {
        await browserConnection?.close().catch(() => undefined);
        browserConnection = null;
        throw error;
      }
    },
    getInstalledExecutableVersion: async () => installedExecutableVersion(),
    isOriginalProcessRunning: async () => Boolean(applicationProcess && applicationProcess.exitCode === null),
    getInstalledProcessCount: async () => installedAppProcessCount(),
    stopInstalledProcesses: async () => stopInstalledAppProcesses(),
    launchForVerification: async () => {
      const page = await launchInstalledApp({ executablePath: path.join(INSTALL_DIR, "SiteIndex.exe"), trace: true });
      const state = await appState(page);
      return { page, version: state.version };
    },
    now: () => Date.now(),
    wait: delay,
    intervalMs: 1000,
    timeoutMs: 180_000,
    formatError: safeMessage,
  });
  report.updaterRestart = result.updaterRestart;
  return result.connected.page;
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
  for (const base of [APP_DATA_ROOT, LOCAL_APP_DATA_ROOT]) {
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
    if (file.toLowerCase().startsWith(LOCAL_APP_DATA_ROOT.toLowerCase())) return "local-app-data";
    return "other-siteindex-data";
  });
  return { rootCount: roots.length, fileCount: files.size, locations: [...new Set(locations)], text: contents.join("\n") };
}

async function stopApplication() {
  if (browserConnection) {
    let pages = [];
    try {
      pages = browserConnection.contexts().flatMap((context) => context.pages());
    } catch {
      // The updater may already have disconnected the old renderer.
    }
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
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
  stopInstalledAppProcesses();
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

async function requestHostedUpdate(page) {
  const available = await page.evaluate(async () => {
    const updates = window.siteindex?.updates;
    if (!updates) throw new Error("The installed baseline does not expose the update API.");
    return updates.check();
  });
  assert(available.state === "available" && available.latest === CANDIDATE_VERSION,
    "packaged baseline discovers the published GitHub candidate through electron-updater", {
      state: available.state,
      latest: available.latest ?? null,
      expectedVersion: CANDIDATE_VERSION,
    });

  await page.evaluate(async () => {
    const updates = window.siteindex?.updates;
    if (!updates) throw new Error("The installed baseline does not expose the update API.");
    await updates.download();
  });
  const ready = await page.evaluate(async () => {
    const updates = window.siteindex?.updates;
    if (!updates) throw new Error("The installed baseline does not expose the update API.");
    return updates.check();
  });
  assert(ready.state === "ready" && ready.latest === CANDIDATE_VERSION,
    "electron-updater finishes downloading the published candidate before install", {
      state: ready.state,
      latest: ready.latest ?? null,
      expectedVersion: CANDIDATE_VERSION,
    });

  await page.evaluate(() => {
    const updates = window.siteindex?.updates;
    if (!updates) throw new Error("The installed baseline does not expose the update API.");
    void updates.install().catch(() => undefined);
    return true;
  }).catch(() => undefined);
  await delay(1000);
  return waitForHostedUpdatedApp();
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

function w2DataTableSelector(tableId) {
  return `.si-data-table[aria-label="${tableId} 数据表"]:visible`;
}

async function waitForW2Table(page, tableId) {
  const selector = w2DataTableSelector(tableId);
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(`${selector} .si-pagination-count`).first().waitFor({ state: "visible", timeout: 20_000 });
}

async function readW2TableMetrics(page, tableId) {
  const visibleTables = page.locator(w2DataTableSelector(tableId));
  const visibleTableCount = await visibleTables.count();
  if (visibleTableCount === 0) {
    return {
      tableVisible: false,
      scrollRegionVisible: false,
      renderedRows: 0,
      paginationVisible: false,
      paginationText: "",
      total: null,
      pageSize: null,
      nextEnabled: false,
      headerCount: 0,
      visibleTableCount,
    };
  }

  const table = visibleTables.first();
  const [tableBox, scrollBox, paginationBox, paginationText, pageSize, renderedRows, headerCount, nextEnabled] = await Promise.all([
    table.boundingBox(),
    table.locator(".si-table-scroll").boundingBox(),
    table.locator(".si-pagination").boundingBox(),
    table.locator(".si-pagination-count").innerText().catch(() => ""),
    table.locator('select[aria-label="每页条数"]').inputValue().catch(() => null),
    table.locator("tbody tr[data-row-id]").count(),
    table.locator("thead th").count(),
    table.getByRole("button", { name: "下一页", exact: true }).isEnabled().catch(() => false),
  ]);
  const match = paginationText.match(/\/\s*([\d,]+)/u);
  return {
    tableVisible: Boolean(tableBox && tableBox.width > 0 && tableBox.height > 0),
    scrollRegionVisible: Boolean(scrollBox && scrollBox.height > 0),
    renderedRows,
    paginationVisible: Boolean(paginationBox && paginationBox.height > 0),
    paginationText: paginationText.trim(),
    total: match ? Number(match[1].replaceAll(",", "").trim()) : null,
    pageSize,
    nextEnabled,
    headerCount,
    visibleTableCount,
  };
}

async function readW2VisibleRowKeys(page, tableId) {
  return page.locator(`${w2DataTableSelector(tableId)} tbody tr[data-row-id]`).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-row-id") ?? row.textContent?.trim() ?? ""));
}

function parseW2PaginationRange(text) {
  const match = text.match(/显示\s*([\d,]+)\s*[–-]\s*([\d,]+)\s*\/\s*([\d,]+)/u);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part.replaceAll(",", "")));
}

async function waitForW2TableTotal(page, tableId, expectedTotal, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await readW2TableMetrics(page, tableId);
  while (Date.now() < deadline) {
    if (metrics.tableVisible && metrics.total === expectedTotal && metrics.renderedRows > 0) return metrics;
    await delay(100);
    metrics = await readW2TableMetrics(page, tableId);
  }
  throw new Error(`表格未在 ${timeoutMs} ms 内稳定到预期总数 ${expectedTotal}；当前 ${metrics.paginationText || "无分页信息"}`);
}

async function waitForW2PaginationPage(page, tableId, expectedTotal, expectedStart, expectedRowKeys, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await readW2TableMetrics(page, tableId);
  let rowKeys = await readW2VisibleRowKeys(page, tableId);
  while (Date.now() < deadline) {
    const range = parseW2PaginationRange(metrics.paginationText);
    const rowsMatch = expectedRowKeys ? rowKeys.join("\n") === expectedRowKeys.join("\n") : rowKeys.length > 0;
    if (range?.[0] === expectedStart && range[2] === expectedTotal && rowsMatch) return { metrics, rowKeys };
    await delay(100);
    metrics = await readW2TableMetrics(page, tableId);
    rowKeys = await readW2VisibleRowKeys(page, tableId);
  }
  throw new Error(`分页未到达第 ${expectedStart} 行且数据行未稳定；当前 ${metrics.paginationText || "无分页信息"}`);
}

async function exerciseW2Pagination(page, tableId, expectedTotal) {
  let initialWaitError = null;
  try {
    await waitForW2TableTotal(page, tableId, expectedTotal);
  } catch (error) {
    initialWaitError = safeMessage(error);
  }
  const before = await readW2TableMetrics(page, tableId);
  const table = page.locator(w2DataTableSelector(tableId)).first();
  const nextButton = table.getByRole("button", { name: "下一页", exact: true });
  const nextButtonCount = await nextButton.count();
  const firstPageRows = await readW2VisibleRowKeys(page, tableId);
  let advanced = false;
  let returned = false;
  let clickCompleted = false;
  let advanceError = null;
  let returnError = null;
  let secondPage = null;
  let secondPageRows = [];
  let restoredPageRows = [];
  const firstRange = parseW2PaginationRange(before.paginationText);
  if (initialWaitError === null && before.nextEnabled && nextButtonCount === 1 && firstRange?.[0] === 1) {
    try {
      await nextButton.click({ timeout: 5_000 });
      clickCompleted = true;
      const expectedSecondStart = Number(before.pageSize) + 1;
      const secondState = await waitForW2PaginationPage(page, tableId, expectedTotal, expectedSecondStart, null);
      secondPage = secondState.metrics;
      secondPageRows = secondState.rowKeys;
      advanced = secondPage.total === expectedTotal
        && secondPage.renderedRows > 0
        && firstPageRows.join("\n") !== secondPageRows.join("\n");
    } catch (error) {
      advanceError = safeMessage(error);
      secondPage = await readW2TableMetrics(page, tableId).catch(() => null);
      secondPageRows = await readW2VisibleRowKeys(page, tableId).catch(() => []);
    }
    const previousButton = table.getByRole("button", { name: "上一页", exact: true });
    if (clickCompleted && secondPage?.paginationText !== before.paginationText
      && await previousButton.count() === 1 && await previousButton.isEnabled().catch(() => false)) {
      try {
        await previousButton.click({ timeout: 5_000 });
        const restoredState = await waitForW2PaginationPage(page, tableId, expectedTotal, 1, firstPageRows);
        restoredPageRows = restoredState.rowKeys;
        returned = true;
      } catch (error) {
        returnError = safeMessage(error);
      }
    }
  }
  const passed = before.tableVisible && before.scrollRegionVisible && before.paginationVisible
    && before.total === expectedTotal && before.headerCount > 0 && before.nextEnabled
    && nextButtonCount === 1 && clickCompleted && advanced && returned;
  return { passed, evidence: {
    before,
    expectedTotal,
    nextButtonCount,
    clickCompleted,
    firstPageRowCount: firstPageRows.length,
    initialWaitError,
    firstPageRange: firstRange,
    secondPage,
    secondPageRowCount: secondPageRows.length,
    secondPageRowsDiffer: firstPageRows.join("\n") !== secondPageRows.join("\n"),
    advanceError,
    returned,
    restoredFirstPageRows: restoredPageRows.length,
    returnError,
  } };
}

async function packagedW2Baseline(page) {
  return page.evaluate(async ({ projectId, intentionalOrphanPath }) => {
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
    const orphanPages = pages.rows.filter((row) => row.links_internal_in === 0);
    const intentionalOrphanPresent = orphanPages.length === 1
      && orphanPages[0].page_type === "product"
      && new URL(orphanPages[0].url).pathname === intentionalOrphanPath;
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
      seo: { issues: issues.total, pages: pages.total, links: links.total, orphanPages: orphanPages.length, intentionalOrphanPresent },
      overview: { attentionCount: overview.attention.length, firstSeoRule: attentionRule },
    };
  }, { projectId: W2_PROJECT_ID, intentionalOrphanPath: W2_EXPECTED.intentionalOrphanPath });
}

async function attemptW2(name, evidenceType, action) {
  const diagnosticsStart = w2RuntimeDiagnostics.length;
  const checkNumber = report.w2Acceptance.checks.length + 1;
  activeW2CheckNumber = checkNumber;
  try {
    const result = await action();
    const evidence = result.evidence ?? result;
    if (!result.passed) {
      evidence.runtimeDiagnostics = w2RuntimeDiagnostics.slice(diagnosticsStart).slice(0, 20);
      try {
        evidence.failureScreenshot = await captureW2FailureScreenshot(pageForW2Diagnostics, checkNumber);
      } catch (error) {
        evidence.failureScreenshotError = safeMessage(error);
      }
    }
    recordW2(name, result.passed, evidenceType, evidence);
    return result;
  } catch (error) {
    const evidence = {
      error: safeMessage(error),
      runtimeDiagnostics: w2RuntimeDiagnostics.slice(diagnosticsStart).slice(0, 20),
    };
    try {
      evidence.failureScreenshot = await captureW2FailureScreenshot(pageForW2Diagnostics, checkNumber);
    } catch (screenshotError) {
      evidence.failureScreenshotError = safeMessage(screenshotError);
    }
    recordW2(name, false, evidenceType, evidence);
    return null;
  } finally {
    activeW2CheckNumber = null;
  }
}

let pageForW2Diagnostics = null;

async function captureW2FailureScreenshot(page, checkNumber, kind = "failure") {
  if (!page || page.isClosed()) return null;
  const outputDirectory = OUTPUT_DIR ? path.join(OUTPUT_DIR, "w2-failures") : path.join(TEST_ROOT, "w2-failures");
  await mkdir(outputDirectory, { recursive: true });
  const fileName = `w2-check-${String(checkNumber).padStart(2, "0")}-${kind}.png`;
  await page.screenshot({ path: path.join(outputDirectory, fileName), fullPage: true });
  return path.join("w2-failures", fileName);
}

async function captureW2InteractionScreenshot(page) {
  if (activeW2CheckNumber === null) return null;
  return captureW2FailureScreenshot(page, activeW2CheckNumber, "interaction");
}

async function acceptNextW2Dialog(page, trigger) {
  let resolveDialogHandled;
  const dialogHandled = new Promise((resolve) => { resolveDialogHandled = resolve; });
  const handler = (dialog) => {
    const message = dialog.message();
    void dialog.accept().then(
      () => resolveDialogHandled({ observed: true, accepted: true, message }),
      (error) => resolveDialogHandled({ observed: true, accepted: false, message, error: safeMessage(error) }),
    );
  };
  page.once("dialog", handler);
  let actionError = null;
  try {
    try {
      await trigger();
    } catch (error) {
      actionError = safeMessage(error);
    }
    const result = await Promise.race([dialogHandled, delay(1_000).then(() => null)]);
    return {
      confirmationType: "native-window.confirm",
      actionCompleted: actionError === null,
      actionError,
      dialogObserved: Boolean(result?.observed),
      dialogAccepted: Boolean(result?.accepted),
      message: result?.message ?? null,
      dialogError: result?.error ?? null,
    };
  } finally {
    page.off("dialog", handler);
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
    const all = await read(undefined);
    const open = await read("open");
    const fixed = await read("fixed");
    const ignored = await read("ignored");
    return { all: all.total, open: open.total, fixed: fixed.total, ignored: ignored.total };
  }, { projectId: W2_PROJECT_ID, targetRule: rule });
}

async function readW2SeoSnapshotSerial(page, rule, rowId) {
  const api = await page.evaluate(async ({ projectId, targetRule, targetRowId }) => {
    const api = window.siteindex;
    const read = (status) => api.seo.listIssues(projectId, {
      page: 1,
      pageSize: 0,
      filters: { rules: [targetRule], ...(status ? { status } : {}) },
    });
    const all = await read(undefined);
    const open = await read("open");
    const fixed = await read("fixed");
    const ignored = await read("ignored");
    const rows = await api.seo.listIssues(projectId, {
      page: 1,
      pageSize: 200,
      filters: { rules: [targetRule] },
    });
    const target = rows.rows.find((issue) => `${issue.url}:${issue.rule}` === targetRowId);
    return {
      counts: { all: all.total, open: open.total, fixed: fixed.total, ignored: ignored.total },
      targetFound: Boolean(target),
      targetStatus: target?.status ?? null,
    };
  }, { projectId: W2_PROJECT_ID, targetRule: rule, targetRowId: rowId });
  const syntheticFile = await readW2SyntheticSeoState(rowId, rule);
  return { mode: "serial", api, syntheticFile };
}

async function readW2SeoSnapshotConcurrent(page, rule, rowId) {
  const api = await page.evaluate(async ({ projectId, targetRule, targetRowId }) => {
    const api = window.siteindex;
    const read = (status) => api.seo.listIssues(projectId, {
      page: 1,
      pageSize: 0,
      filters: { rules: [targetRule], ...(status ? { status } : {}) },
    });
    const [all, open, fixed, ignored, rows] = await Promise.all([
      read(undefined),
      read("open"),
      read("fixed"),
      read("ignored"),
      api.seo.listIssues(projectId, {
        page: 1,
        pageSize: 200,
        filters: { rules: [targetRule] },
      }),
    ]);
    const target = rows.rows.find((issue) => `${issue.url}:${issue.rule}` === targetRowId);
    return {
      counts: { all: all.total, open: open.total, fixed: fixed.total, ignored: ignored.total },
      targetFound: Boolean(target),
      targetStatus: target?.status ?? null,
    };
  }, { projectId: W2_PROJECT_ID, targetRule: rule, targetRowId: rowId });
  const syntheticFile = await readW2SyntheticSeoState(rowId, rule);
  return { mode: "concurrent", api, syntheticFile };
}

function w2SeoSnapshotMatches(snapshot, expectedCounts, expectedTargetStatus) {
  return Boolean(snapshot?.api?.targetFound)
    && snapshot.api.targetStatus === expectedTargetStatus
    && Object.entries(expectedCounts).every(([key, value]) => snapshot.api.counts?.[key] === value)
    && Boolean(snapshot?.syntheticFile?.targetFound)
    && snapshot.syntheticFile.targetStatus === expectedTargetStatus
    && Object.entries(expectedCounts).every(([key, value]) => snapshot.syntheticFile.counts?.[key] === value);
}

function fingerprintW2RowIdentity(rowId) {
  return typeof rowId === "string" && rowId.length > 0
    ? createHash("sha256").update(rowId).digest("hex").slice(0, 16)
    : null;
}

async function readW2SyntheticSeoState(rowId, rule) {
  if (!rowId) return { targetFound: false, targetStatus: null, counts: { all: 0, open: 0, fixed: 0, ignored: 0 } };
  const issuesPath = path.join(W2_PROJECT_DIRECTORY, "index", "seo", "issues.jsonl");
  try {
    const [source, metadata] = await Promise.all([readFile(issuesPath, "utf8"), statFile(issuesPath)]);
    const issues = source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const ruleIssues = issues.filter((issue) => issue.rule === rule);
    const target = ruleIssues.find((issue) => `${issue.url}:${issue.rule}` === rowId);
    return {
      targetFound: Boolean(target),
      targetStatus: target?.status ?? null,
      counts: {
        all: ruleIssues.length,
        open: ruleIssues.filter((issue) => issue.status === "open").length,
        fixed: ruleIssues.filter((issue) => issue.status === "fixed").length,
        ignored: ruleIssues.filter((issue) => issue.status === "ignored").length,
      },
      file: { sizeBytes: metadata.size, modifiedAt: metadata.mtime.toISOString() },
      readError: null,
    };
  } catch (error) {
    return {
      targetFound: false,
      targetStatus: null,
      counts: { all: null, open: null, fixed: null, ignored: null },
      file: null,
      readError: safeMessage(error),
    };
  }
}

async function waitForW2SeoStateEvidence(page, rule, rowId, expectedCounts, expectedTargetStatus, timeoutMs = 15_000) {
  const startedAt = Date.now();
  const samples = [];
  let consecutiveMatches = 0;
  while (Date.now() - startedAt < timeoutMs) {
    let snapshot;
    let matched = false;
    try {
      snapshot = await readW2SeoSnapshotSerial(page, rule, rowId);
      matched = w2SeoSnapshotMatches(snapshot, expectedCounts, expectedTargetStatus);
    } catch (error) {
      snapshot = { mode: "serial", readError: safeMessage(error) };
    }
    consecutiveMatches = matched ? consecutiveMatches + 1 : 0;
    samples.push({ ...snapshot, matched });
    if (consecutiveMatches >= 3) {
      const concurrentSnapshot = await readW2SeoSnapshotConcurrent(page, rule, rowId);
      const concurrentMatches = w2SeoSnapshotMatches(concurrentSnapshot, expectedCounts, expectedTargetStatus);
      return {
        passed: concurrentMatches,
        expectedCounts,
        expectedTargetStatus,
        consecutiveMatches,
        consecutiveReadMode: "serial IPC reads with target status and synthetic JSONL state",
        rowIdentityFingerprint: fingerprintW2RowIdentity(rowId),
        samples: samples.slice(-3),
        concurrentSnapshot,
        concurrentMatches,
      };
    }
    await delay(200);
  }
  return {
    passed: false,
    expectedCounts,
    expectedTargetStatus,
    consecutiveMatches,
    consecutiveReadMode: "serial IPC reads with target status and synthetic JSONL state",
    rowIdentityFingerprint: fingerprintW2RowIdentity(rowId),
    samples: samples.slice(-5),
    concurrentSnapshot: await readW2SeoSnapshotConcurrent(page, rule, rowId).catch((error) => ({ mode: "concurrent", readError: safeMessage(error) })),
  };
}

async function readW2UpdateResultToast(page) {
  const texts = await page.locator(".si-toast-region .si-toast").allTextContents().catch(() => []);
  const text = texts.map((value) => value.trim()).filter(Boolean).at(-1) ?? null;
  const match = text?.match(/^已更新\s*(\d+)\s*条$/u);
  return { count: texts.length, text, updated: match ? Number(match[1]) : null };
}

async function waitForW2UpdateResultToast(page, expectedUpdated = 1, previousCount = 0, timeoutMs = 5_000) {
  const startedAt = Date.now();
  let last = { count: 0, text: null, updated: null };
  while (Date.now() - startedAt < timeoutMs) {
    last = await readW2UpdateResultToast(page);
    if (last.count > previousCount && last.updated === expectedUpdated) return { observed: true, previousCount, ...last };
    await delay(100);
  }
  return { observed: false, previousCount, ...last };
}

function withoutW2RawRowIdentity(action) {
  const { targetRowIdentity, ...safeAction } = action;
  return safeAction;
}

async function readW2SeoRuleState(page, rule) {
  return page.evaluate(async ({ projectId, targetRule }) => {
    const api = window.siteindex;
    const [settings, summary, open, ignored] = await Promise.all([
      api.seo.getRuleSettings(projectId),
      api.seo.summary(projectId),
      api.seo.listIssues(projectId, { page: 1, pageSize: 0, filters: { rules: [targetRule], status: "open" } }),
      api.seo.listIssues(projectId, { page: 1, pageSize: 0, filters: { rules: [targetRule], status: "ignored" } }),
    ]);
    const setting = settings.find((item) => item.rule === targetRule);
    const openSummary = summary.kpis.find((item) => item.key === "issues")?.value ?? "";
    return {
      ruleIgnored: setting?.ignored ?? null,
      rulePendingCount: setting?.pending_count ?? null,
      summaryOpenCount: Number(openSummary),
      ruleOpenCount: open.total,
      ruleIgnoredCount: ignored.total,
    };
  }, { projectId: W2_PROJECT_ID, targetRule: rule });
}

async function waitForW2SeoRuleState(page, rule, expected) {
  await page.waitForFunction(async ({ projectId, targetRule, state }) => {
    const api = window.siteindex;
    const [settings, summary, open, ignored] = await Promise.all([
      api.seo.getRuleSettings(projectId),
      api.seo.summary(projectId),
      api.seo.listIssues(projectId, { page: 1, pageSize: 0, filters: { rules: [targetRule], status: "open" } }),
      api.seo.listIssues(projectId, { page: 1, pageSize: 0, filters: { rules: [targetRule], status: "ignored" } }),
    ]);
    const setting = settings.find((item) => item.rule === targetRule);
    const summaryOpen = Number(summary.kpis.find((item) => item.key === "issues")?.value ?? NaN);
    return setting?.ignored === state.ruleIgnored
      && setting.pending_count === state.rulePendingCount
      && summaryOpen === state.summaryOpenCount
      && open.total === state.ruleOpenCount
      && ignored.total === state.ruleIgnoredCount;
  }, { projectId: W2_PROJECT_ID, targetRule: rule, state: expected }, { timeout: 15_000 });
}

async function readW2SeoOpenKpi(page) {
  return page.evaluate(() => {
    const region = document.querySelector(".si-seo-kpis");
    const text = region?.innerText ?? "";
    const match = text.match(/开放问题\s*([\d,]+)/u);
    return match ? Number(match[1].replaceAll(",", "")) : null;
  });
}

async function waitForW2SeoOpenKpi(page, expectedCount) {
  await page.waitForFunction((expected) => {
    const region = document.querySelector(".si-seo-kpis");
    const match = region?.innerText.match(/开放问题\s*([\d,]+)/u);
    return Boolean(match && Number(match[1].replaceAll(",", "")) === expected);
  }, expectedCount, { timeout: 15_000 });
}

async function readW2SeoUiContext(page) {
  return page.evaluate(() => {
    const [, query = ""] = window.location.hash.split("?");
    const params = new URLSearchParams(query);
    const statusControl = document.querySelector('.si-seo-dropdown-trigger[aria-label^="状态"]');
    return {
      onSeoRoute: /\/seo(?:\?|$)/u.test(window.location.hash),
      rule: params.get("rule"),
      status: params.get("status"),
      issueRowCount: document.querySelector('.si-data-table[aria-label="seo.issues.v2 数据表"]')?.querySelectorAll("tbody tr[data-row-id]").length ?? 0,
      statusLabelPresent: Boolean(statusControl),
    };
  });
}

async function clickW2IssueActionWithConfirmation(page, menuItemName, rule) {
  const issueTable = page.locator(w2DataTableSelector("seo.issues.v2")).first();
  const rows = issueTable.locator("tbody tr[data-row-id]");
  const rowCount = await rows.count();
  const rowIndex = 0;
  const row = rows.nth(rowIndex);
  const targetRowIdentity = rowCount > 0 ? await row.getAttribute("data-row-id").catch(() => null) : null;
  const targetRowIdentityFingerprint = fingerprintW2RowIdentity(targetRowIdentity);
  const targetBeforeState = targetRowIdentity
    ? await readW2SeoSnapshotSerial(page, rule, targetRowIdentity).catch((error) => ({ mode: "serial", readError: safeMessage(error) }))
    : null;
  const toastCountBefore = await page.locator(".si-toast-region .si-toast").count().catch(() => 0);
  let actionButton = row.locator("button.si-seo-row-action");
  let actionButtonCount = 0;
  let accessibleActionButtonCount = 0;
  let rowDiagnostics = null;
  let wheelBefore = null;
  let wheelAfter = null;
  let rowHoverError = null;
  let scrollHoverError = null;
  const wheelDeltaY = -120;
  if (rowCount > 0) {
    const scrollRegion = issueTable.locator(".si-table-scroll");
    wheelBefore = await scrollRegion.evaluate((element) => element.scrollTop).catch(() => null);
    try {
      await scrollRegion.hover({ timeout: 5_000 });
      await page.mouse.wheel(0, wheelDeltaY);
      await delay(150);
    } catch (error) {
      scrollHoverError = safeMessage(error);
    }
    wheelAfter = await scrollRegion.evaluate((element) => element.scrollTop).catch(() => null);
    try {
      await row.hover({ timeout: 5_000 });
    } catch (error) {
      rowHoverError = safeMessage(error);
    }
    await actionButton.first().waitFor({ state: "attached", timeout: 1_000 }).catch(() => undefined);
    actionButtonCount = await actionButton.count();
    accessibleActionButtonCount = await row.getByRole("button", { name: /问题操作：/u }).count();
    rowDiagnostics = await row.evaluate((element) => ({
      tagName: element.tagName,
      className: typeof element.className === "string" ? element.className : "",
      dataRowIdPresent: element.hasAttribute("data-row-id"),
      cellCount: element.querySelectorAll("td").length,
      cellClasses: [...element.querySelectorAll("td")].map((cell) => cell.className),
      buttonClasses: [...element.querySelectorAll("button")].map((button) => button.className),
      actionClassCount: element.querySelectorAll(".si-seo-row-action").length,
      actionCellPresent: Boolean(element.querySelector('td[data-column-id="actions"], td[data-column="actions"]')),
    }));
  }
  if (rowCount === 0 || actionButtonCount !== 1) {
    const failureScreenshot = await captureW2InteractionScreenshot(page).catch(() => null);
    return {
      confirmationType: "native-window.confirm",
      actionCompleted: false,
      actionError: "指定问题行或其操作按钮数量不符合预期",
      dialogObserved: false,
      dialogAccepted: false,
      message: null,
      dialogError: null,
      rowCount,
      rowIndex,
      targetRowIdentity,
      targetRowIdentityFingerprint,
      targetBeforeState,
      toastCountBefore,
      actionButtonCount,
      accessibleActionButtonCount,
      rowDiagnostics,
      scrollHoverError,
      rowHoverError,
      normalWheel: { deltaY: wheelDeltaY, scrollTopBefore: wheelBefore, scrollTopAfter: wheelAfter },
      failureScreenshot,
      menuItemCount: 0,
      menuItemVisible: false,
    };
  }

  let menuItemCount = 0;
  let menuItemVisible = false;
  let targetGeometry = null;
  try {
    const readTargetGeometry = () => actionButton.first().evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const header = button.closest("table")?.querySelector("thead th.is-sticky-right");
      const headerRect = header?.getBoundingClientRect();
      const overlapWidth = headerRect ? Math.max(0, Math.min(rect.right, headerRect.right) - Math.max(rect.left, headerRect.left)) : 0;
      const overlapHeight = headerRect ? Math.max(0, Math.min(rect.bottom, headerRect.bottom) - Math.max(rect.top, headerRect.top)) : 0;
      return {
        button: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        stickyHeader: headerRect ? { x: Math.round(headerRect.x), y: Math.round(headerRect.y), width: Math.round(headerRect.width), height: Math.round(headerRect.height) } : null,
        stickyHeaderOverlapsButton: overlapWidth > 0 && overlapHeight > 0,
        buttonBelowStickyHeader: !headerRect || rect.top >= headerRect.bottom,
      };
    });
    targetGeometry = await readTargetGeometry();
    await actionButton.first().click({ timeout: 5_000 });
    const menuItem = page.getByRole("menuitem", { name: menuItemName, exact: true });
    menuItemCount = await menuItem.count();
    menuItemVisible = menuItemCount === 1 && await menuItem.isVisible();
    if (!menuItemVisible) {
      const failureScreenshot = await captureW2InteractionScreenshot(page).catch(() => null);
      return {
        confirmationType: "native-window.confirm",
        actionCompleted: false,
        actionError: "指定操作菜单项未唯一显示",
        dialogObserved: false,
        dialogAccepted: false,
        message: null,
        dialogError: null,
        rowCount,
        actionButtonCount,
        menuItemCount,
        menuItemVisible,
        targetGeometry,
        targetRowIdentity,
        targetRowIdentityFingerprint,
        targetBeforeState,
        toastCountBefore,
        rowIndex,
        normalWheel: { deltaY: wheelDeltaY, scrollTopBefore: wheelBefore, scrollTopAfter: wheelAfter },
        failureScreenshot,
      };
    }
    const confirmation = await acceptNextW2Dialog(page, () => menuItem.click({ timeout: 5_000 }));
    return {
      ...confirmation,
      rowCount,
      rowIndex,
      targetRowIdentity,
      targetRowIdentityFingerprint,
      targetBeforeState,
      toastCountBefore,
      actionButtonCount,
      menuItemCount,
      menuItemVisible,
      targetGeometry,
      normalWheel: { deltaY: wheelDeltaY, scrollTopBefore: wheelBefore, scrollTopAfter: wheelAfter },
    };
  } catch (error) {
    targetGeometry = await actionButton.first().evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const header = button.closest("table")?.querySelector("thead th.is-sticky-right");
      const headerRect = header?.getBoundingClientRect();
      const overlapWidth = headerRect ? Math.max(0, Math.min(rect.right, headerRect.right) - Math.max(rect.left, headerRect.left)) : 0;
      const overlapHeight = headerRect ? Math.max(0, Math.min(rect.bottom, headerRect.bottom) - Math.max(rect.top, headerRect.top)) : 0;
      return {
        button: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        stickyHeader: headerRect ? { x: Math.round(headerRect.x), y: Math.round(headerRect.y), width: Math.round(headerRect.width), height: Math.round(headerRect.height) } : null,
        stickyHeaderOverlapsButton: overlapWidth > 0 && overlapHeight > 0,
        buttonBelowStickyHeader: !headerRect || rect.top >= headerRect.bottom,
      };
    }).catch(() => targetGeometry);
    const failureScreenshot = await captureW2InteractionScreenshot(page).catch(() => null);
    return {
      confirmationType: "native-window.confirm",
      actionCompleted: false,
      actionError: safeMessage(error),
      dialogObserved: false,
      dialogAccepted: false,
      message: null,
      dialogError: null,
      rowCount,
      rowIndex,
      targetRowIdentity,
      targetRowIdentityFingerprint,
      targetBeforeState,
      toastCountBefore,
      actionButtonCount,
      menuItemCount,
      menuItemVisible,
      targetGeometry,
      normalWheel: { deltaY: wheelDeltaY, scrollTopBefore: wheelBefore, scrollTopAfter: wheelAfter },
      failureScreenshot,
    };
  }
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
  pageForW2Diagnostics = page;
  w2RuntimeDiagnostics = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      w2RuntimeDiagnostics.push({ type: `console-${message.type()}`, message: safeMessage(message.text()) });
    }
  });
  page.on("pageerror", (error) => {
    w2RuntimeDiagnostics.push({ type: "pageerror", message: safeMessage(error) });
  });
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
      && baseline.seo.orphanPages === 1
      && baseline.seo.intentionalOrphanPresent
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
    await waitForW2Table(page, "seo.issues.v2");
    const pagination = await exerciseW2Pagination(page, "seo.issues.v2", W2_EXPECTED.issues - 6);
    const columnText = await page.locator('.si-data-table[aria-label="seo.issues.v2 数据表"] thead').innerText();
    const statusColumn = columnText.includes("状态");
    const statusFilterVisible = await page.locator('.si-seo-dropdown-trigger[aria-label^="状态"]').isVisible();
    const passed = pagination.passed && statusColumn && statusFilterVisible;
    return { passed, evidence: { ...pagination, statusColumn, statusFilterVisible } };
  });

  await attemptW2("SEO issue action marks a row processed and restores it through the UI", "ui", async () => {
    await waitForW2Table(page, "seo.issues.v2");
    const initialUi = await readW2SeoUiContext(page);
    const before = await readW2SeoStatusCounts(page, "title_missing");
    const routeAndFilterReady = initialUi.onSeoRoute && initialUi.rule === "title_missing"
      && initialUi.status === "open" && initialUi.statusLabelPresent && initialUi.issueRowCount > 0;
    const processedConfirmation = routeAndFilterReady
      ? await clickW2IssueActionWithConfirmation(page, "标记已处理", "title_missing")
      : {
        confirmationType: "native-window.confirm",
        actionCompleted: false,
        actionError: "操作前的 SEO 页面或 open 筛选不符合预期",
        dialogObserved: false,
        dialogAccepted: false,
        message: null,
        dialogError: null,
        rowCount: initialUi.issueRowCount,
        targetRowIdentity: null,
        targetRowIdentityFingerprint: null,
        targetBeforeState: null,
        toastCountBefore: 0,
        actionButtonCount: 0,
        menuItemCount: 0,
        menuItemVisible: false,
      };
    const processedConfirmationMatches = processedConfirmation.dialogObserved
      && processedConfirmation.dialogAccepted
      && processedConfirmation.message?.includes("标记为已处理？")
      && processedConfirmation.message?.includes("单条 SEO 问题");
    const processedBeforeStateMatches = Boolean(processedConfirmation.targetBeforeState)
      && w2SeoSnapshotMatches(processedConfirmation.targetBeforeState, before, "open");
    const processedToast = processedConfirmation.dialogAccepted
      ? await waitForW2UpdateResultToast(page, 1, processedConfirmation.toastCountBefore ?? 0)
      : { observed: false, previousCount: processedConfirmation.toastCountBefore ?? 0, count: null, text: null, updated: null };
    const expectedOpenAfterProcess = before.open - 1;
    const expectedAfterProcess = { ...before, open: expectedOpenAfterProcess, fixed: before.fixed + 1 };
    const processedStateEvidence = processedConfirmation.dialogAccepted && processedConfirmation.targetRowIdentity
      ? await waitForW2SeoStateEvidence(page, "title_missing", processedConfirmation.targetRowIdentity, expectedAfterProcess, "fixed")
      : { passed: false, reason: "processed action was not confirmed or target row identity was missing", samples: [] };
    let processedWaitError = null;
    if (processedConfirmation.dialogAccepted) {
      try {
        await waitForW2SeoCount(page, "title_missing", "fixed", before.fixed + 1);
      } catch (error) {
        processedWaitError = safeMessage(error);
      }
    }
    let openPaginationWaitError = null;
    try {
      await page.waitForFunction((expected) => {
        const table = document.querySelector('.si-data-table[aria-label="seo.issues.v2 数据表"]');
        const count = table?.querySelector(".si-pagination-count")?.textContent ?? "";
        return count.includes(`/ ${expected}`);
      }, String(expectedOpenAfterProcess), { timeout: 10_000 });
    } catch (error) {
      openPaginationWaitError = safeMessage(error);
    }
    const afterFixed = await readW2SeoStatusCounts(page, "title_missing");
    const statusFilter = page.locator('.si-seo-dropdown-trigger[aria-label^="状态"]');
    let restoreFilterError = null;
    let restoredUi = null;
    try {
      await statusFilter.click();
      await page.getByRole("group", { name: "状态" }).getByRole("button", { name: "已处理", exact: true }).click();
      await waitForW2Table(page, "seo.issues.v2");
      restoredUi = await readW2SeoUiContext(page);
    } catch (error) {
      restoreFilterError = safeMessage(error);
    }
    const restoreActionButtonCount = await page.locator(`${w2DataTableSelector("seo.issues.v2")} tbody tr[data-row-id]`).locator("button.si-seo-row-action").count();
    let restoreConfirmation = {
      confirmationType: "native-window.confirm",
      actionCompleted: false,
      actionError: restoreFilterError ?? "没有可见的已处理行可恢复",
      dialogObserved: false,
      dialogAccepted: false,
      message: null,
      dialogError: null,
      rowCount: 0,
      targetRowIdentity: null,
      targetRowIdentityFingerprint: null,
      targetBeforeState: null,
      toastCountBefore: 0,
      actionButtonCount: 0,
      menuItemCount: 0,
      menuItemVisible: false,
    };
    if (restoreFilterError === null && restoreActionButtonCount > 0) {
      restoreConfirmation = restoredUi?.onSeoRoute && restoredUi.rule === "title_missing" && restoredUi.status === "fixed"
        ? await clickW2IssueActionWithConfirmation(page, "恢复为待处理", "title_missing")
        : { ...restoreConfirmation, actionError: "恢复操作前的 SEO 页面或已处理筛选不符合预期" };
    }
    const restoreConfirmationMatches = restoreConfirmation.dialogObserved
      && restoreConfirmation.dialogAccepted
      && restoreConfirmation.message?.includes("恢复")
      && restoreConfirmation.message?.includes("单条 SEO 问题");
    const sameTargetRow = Boolean(processedConfirmation.targetRowIdentity)
      && processedConfirmation.targetRowIdentity === restoreConfirmation.targetRowIdentity
      && processedConfirmation.targetRowIdentityFingerprint === restoreConfirmation.targetRowIdentityFingerprint;
    const restoreBeforeStateMatches = Boolean(restoreConfirmation.targetBeforeState)
      && w2SeoSnapshotMatches(restoreConfirmation.targetBeforeState, expectedAfterProcess, "fixed");
    const restoreToast = restoreConfirmation.dialogAccepted
      ? await waitForW2UpdateResultToast(page, 1, restoreConfirmation.toastCountBefore ?? 0)
      : { observed: false, previousCount: restoreConfirmation.toastCountBefore ?? 0, count: null, text: null, updated: null };
    const restoreStateEvidence = restoreConfirmation.dialogAccepted && restoreConfirmation.targetRowIdentity
      ? await waitForW2SeoStateEvidence(page, "title_missing", restoreConfirmation.targetRowIdentity, before, "open")
      : { passed: false, reason: "restore action was not confirmed or target row identity was missing", samples: [] };
    let restoreWaitError = null;
    if (restoreConfirmation.dialogAccepted) {
      try {
        await waitForW2SeoCount(page, "title_missing", "open", before.open);
      } catch (error) {
        restoreWaitError = safeMessage(error);
      }
    }
    const statusCounts = await readW2SeoStatusCounts(page, "title_missing");
    const passed = processedConfirmation.actionCompleted
      && processedConfirmation.actionButtonCount === 1 && processedConfirmation.menuItemCount === 1
      && processedConfirmation.menuItemVisible
      && restoreConfirmation.actionCompleted
      && restoreConfirmation.actionButtonCount === 1 && restoreConfirmation.menuItemCount === 1
      && restoreConfirmation.menuItemVisible
      && routeAndFilterReady
      && before.open === W2_EXPECTED.issues - 6
      && processedConfirmationMatches && restoreConfirmationMatches
      && processedBeforeStateMatches && restoreBeforeStateMatches && sameTargetRow
      && processedToast.observed && processedToast.updated === 1
      && restoreToast.observed && restoreToast.updated === 1
      && processedStateEvidence.passed && restoreStateEvidence.passed
      && afterFixed.fixed === before.fixed + 1
      && afterFixed.open === expectedOpenAfterProcess
      && afterFixed.all === before.all && afterFixed.ignored === before.ignored
      && statusCounts.open === before.open
      && statusCounts.fixed === before.fixed
      && statusCounts.all === before.all && statusCounts.ignored === before.ignored
      && openPaginationWaitError === null;
    const processedActionEvidence = withoutW2RawRowIdentity(processedConfirmation);
    const restoreActionEvidence = withoutW2RawRowIdentity(restoreConfirmation);
    return {
      passed,
      evidence: {
        confirmationType: "native-window.confirm",
        initialUi,
        before,
        sameTargetRow,
        processedAction: { ...processedActionEvidence, message: undefined, messageMatchesExpectedScope: Boolean(processedConfirmationMatches), beforeStateMatches: processedBeforeStateMatches, toast: processedToast, stableState: processedStateEvidence, stateWaitError: processedWaitError },
        afterFixed,
        openPaginationWaitError,
        restoreFilterError,
        restoredUi,
        restoreAction: { ...restoreActionEvidence, message: undefined, messageMatchesExpectedScope: Boolean(restoreConfirmationMatches), beforeStateMatches: restoreBeforeStateMatches, toast: restoreToast, stableState: restoreStateEvidence, stateWaitError: restoreWaitError },
        afterRestore: statusCounts,
        restoredToOpen: statusCounts.open === before.open && statusCounts.fixed === before.fixed,
      },
    };
  });

  await attemptW2("SEO rules Drawer ignores and restores a rule class", "ui", async () => {
    await clickProjectTab(page, "SEO");
    await page.locator(".si-seo-controls").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: "规则设置", exact: true }).click();
    let ruleSection = page.locator(".si-seo-rule-setting").filter({ hasText: "Title 缺失" }).first();
    await ruleSection.waitFor({ state: "visible", timeout: 15_000 });
    const before = await readW2SeoRuleState(page, "title_missing");
    const beforeCounts = await readW2SeoStatusCounts(page, "title_missing");
    const beforeUiOpenCount = await readW2SeoOpenKpi(page);
    const ignoreButton = ruleSection.getByRole("button", { name: "忽略此规则", exact: true });
    const ignoreButtonCount = await ignoreButton.count();
    const ignoreButtonVisible = ignoreButtonCount === 1 && await ignoreButton.isVisible();
    const ignoreConfirmation = await acceptNextW2Dialog(page, () => ignoreButton.click({ timeout: 5_000 }));
    const ignoreConfirmationMatches = ignoreConfirmation.dialogObserved
      && ignoreConfirmation.dialogAccepted
      && ignoreConfirmation.message?.includes("忽略")
      && ignoreConfirmation.message?.includes("全站同一规则");
    let ignoreWaitError = null;
    const expectedIgnoredState = {
      ruleIgnored: true,
      rulePendingCount: 0,
      summaryOpenCount: before.summaryOpenCount - before.rulePendingCount,
      ruleOpenCount: 0,
      ruleIgnoredCount: beforeCounts.open,
    };
    try {
      await waitForW2SeoRuleState(page, "title_missing", expectedIgnoredState);
    } catch (error) {
      ignoreWaitError = safeMessage(error);
    }
    let ignoreUiWaitError = null;
    try {
      await waitForW2SeoOpenKpi(page, expectedIgnoredState.summaryOpenCount);
    } catch (error) {
      ignoreUiWaitError = safeMessage(error);
    }
    const ignored = await readW2SeoRuleState(page, "title_missing");
    const ignoredCounts = await readW2SeoStatusCounts(page, "title_missing");
    const ignoredUiOpenCount = await readW2SeoOpenKpi(page);
    const ruleDrawer = page.locator(".si-drawer");
    let drawerReopenedForRestore = false;
    if (!await ruleDrawer.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "规则设置", exact: true }).click();
      drawerReopenedForRestore = true;
      ruleSection = page.locator(".si-seo-rule-setting").filter({ hasText: "Title 缺失" }).first();
      await ruleSection.waitFor({ state: "visible", timeout: 15_000 });
    }
    const restoreButton = ruleSection.getByRole("button", { name: "恢复此规则", exact: true });
    const restoreButtonCount = await restoreButton.count();
    const restoreButtonVisible = restoreButtonCount === 1 && await restoreButton.isVisible();
    let restoreRuleConfirmation = {
      confirmationType: "native-window.confirm",
      actionCompleted: false,
      actionError: "规则设置未显示可恢复状态",
      dialogObserved: false,
      dialogAccepted: false,
      message: null,
      dialogError: null,
    };
    if (restoreButtonVisible && ignored.ruleIgnored === true) {
      restoreRuleConfirmation = await acceptNextW2Dialog(page, () => restoreButton.click({ timeout: 5_000 }));
    }
    const restoreRuleConfirmationMatches = restoreRuleConfirmation.dialogObserved
      && restoreRuleConfirmation.dialogAccepted
      && restoreRuleConfirmation.message?.includes("恢复")
      && restoreRuleConfirmation.message?.includes("全站同一规则");
    let restoreWaitError = null;
    let restoreUiWaitError = null;
    if (restoreRuleConfirmation.dialogAccepted) {
      try {
        await waitForW2SeoRuleState(page, "title_missing", before);
      } catch (error) {
        restoreWaitError = safeMessage(error);
      }
      try {
        await waitForW2SeoOpenKpi(page, before.summaryOpenCount);
      } catch (error) {
        restoreUiWaitError = safeMessage(error);
      }
    }
    const restored = await readW2SeoRuleState(page, "title_missing");
    const restoredCounts = await readW2SeoStatusCounts(page, "title_missing");
    const restoredUiOpenCount = await readW2SeoOpenKpi(page);
    const passed = ignoreConfirmation.actionCompleted
      && ignoreButtonCount === 1 && ignoreButtonVisible && restoreRuleConfirmation.actionCompleted
      && restoreButtonCount === 1 && restoreButtonVisible
      && before.ruleIgnored === false
      && before.rulePendingCount === beforeCounts.open
      && beforeUiOpenCount === before.summaryOpenCount
      && beforeCounts.open === W2_EXPECTED.issues - 6
      && ignoreConfirmationMatches && restoreRuleConfirmationMatches
      && ignored.ruleIgnored === true && ignored.rulePendingCount === 0
      && ignored.ruleOpenCount === 0 && ignored.ruleIgnoredCount === beforeCounts.open
      && ignored.summaryOpenCount === expectedIgnoredState.summaryOpenCount
      && ignoredUiOpenCount === expectedIgnoredState.summaryOpenCount && ignoreUiWaitError === null
      && ignoredCounts.ignored === beforeCounts.open && ignoredCounts.open === 0
      && restored.ruleIgnored === false
      && restored.rulePendingCount === before.rulePendingCount
      && restored.ruleOpenCount === beforeCounts.open
      && restored.ruleIgnoredCount === 0
      && restored.summaryOpenCount === before.summaryOpenCount
      && restoredUiOpenCount === before.summaryOpenCount && restoreUiWaitError === null
      && restoredCounts.open === beforeCounts.open && restoredCounts.ignored === 0;
    const closeDrawerButton = page.getByRole("button", { name: "关闭抽屉", exact: true });
    if (await closeDrawerButton.count()) await closeDrawerButton.click();
    return {
      passed,
      evidence: {
        confirmationType: "native-window.confirm",
        before,
        beforeCounts,
        beforeUiOpenCount,
        ignoreAction: { ...ignoreConfirmation, message: undefined, buttonCount: ignoreButtonCount, buttonVisible: ignoreButtonVisible, messageMatchesExpectedScope: Boolean(ignoreConfirmationMatches), stateWaitError: ignoreWaitError },
        ignored,
        ignoredCounts,
        ignoredUiOpenCount,
        ignoreUiWaitError,
        restoreAction: { ...restoreRuleConfirmation, message: undefined, buttonCount: restoreButtonCount, buttonVisible: restoreButtonVisible, drawerReopenedForRestore, messageMatchesExpectedScope: Boolean(restoreRuleConfirmationMatches), stateWaitError: restoreWaitError, uiWaitError: restoreUiWaitError },
        restored,
        restoredCounts,
        restoredUiOpenCount,
        drawerOpened: true,
      },
    };
  });

  await attemptW2("Inventory table renders rows and paginates", "ui", async () => {
    await clickProjectTab(page, "库存");
    const parentOnly = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    if (await parentOnly.isChecked()) await parentOnly.uncheck();
    await waitForW2Table(page, "inventory.skus");
    const pagination = await exerciseW2Pagination(page, "inventory.skus", W2_EXPECTED.totalSkus);
    return { passed: pagination.passed, evidence: pagination };
  });

  await attemptW2("Inventory parent-only UI renders the deterministic parent's 30-day trend and rate", "ui", async () => {
    const checkbox = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    await checkbox.check();
    await page.waitForFunction(() => {
      const table = document.querySelector('.si-data-table[aria-label="inventory.skus 数据表"]');
      return table?.querySelector(".si-pagination-count")?.textContent?.includes("/ 80") ?? false;
    }, null, { timeout: 10_000 });
    await waitForW2TableTotal(page, "inventory.skus", W2_EXPECTED.parentGroups + W2_EXPECTED.ungroupedSkus);
    const metrics = await readW2TableMetrics(page, "inventory.skus");
    const toolbarText = await page.locator(".si-table-total").innerText();
    const inventoryTable = page.locator(w2DataTableSelector("inventory.skus"));
    const rowIds = await inventoryTable.locator("tbody tr[data-row-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id") ?? ""));
    const childrenVisible = rowIds.some((value) => /-CH-\d{2}$/u.test(value));
    const parentRow = inventoryTable.locator('tbody tr[data-row-id="SYN-P001"]');
    await parentRow.waitFor({ state: "visible", timeout: 10_000 });
    const trendBar = parentRow.locator(".si-status-cells");
    const trendLabel = await trendBar.getAttribute("aria-label") ?? "";
    const trendStatuses = trendLabel.split("：")[1]?.split("、") ?? [];
    const trendCounts = trendStatuses.reduce((counts, status) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});
    const rateCellTexts = (await parentRow.locator(".si-rate-cell").allInnerTexts()).map((value) => value.trim());
    const onlineRateHeaders = (await inventoryTable.locator("thead th").allInnerTexts())
      .map((value) => value.trim())
      .filter((value) => value.includes("在线率"));
    const trendVisible = await trendBar.isVisible();
    const rate30dVisible = onlineRateHeaders.some((value) => value.includes("30 天")) && rateCellTexts.includes("50%");
    const rate7dVisibleInTable = onlineRateHeaders.some((value) => value.includes("7 天")) && rateCellTexts.includes("100%");
    const passed = metrics.total === W2_EXPECTED.parentGroups + W2_EXPECTED.ungroupedSkus
      && await checkbox.isChecked() && !childrenVisible && toolbarText.includes("父 SKU")
      && trendVisible && trendStatuses.length === 30
      && trendCounts["缺货"] === 15 && trendCounts["有货"] === 15
      && rate30dVisible;
    return { passed, evidence: {
      ...metrics,
      childrenVisible,
      toolbarShowsParentView: toolbarText.includes("父 SKU"),
      parentTrend: { rowId: "SYN-P001", visible: trendVisible, statusCellCount: trendStatuses.length, outOfStockDays: trendCounts["缺货"] ?? 0, inStockDays: trendCounts["有货"] ?? 0 },
      parentOnlineRates: { visibleColumns: onlineRateHeaders, visibleValues: rateCellTexts, expected30d: "50%", sevenDayRateVisibleInTable: rate7dVisibleInTable, expected7dViaPackagedIpc: "100%" },
    } };
  });

  await attemptW2("Products parent-only UI shows grouped products and 3/3 in-stock variants", "ui", async () => {
    await clickProjectTab(page, "产品");
    const checkbox = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    if (await checkbox.isChecked()) await checkbox.uncheck();
    await waitForW2Table(page, "products.list");
    const pagination = await exerciseW2Pagination(page, "products.list", W2_EXPECTED.products);
    await checkbox.check();
    await page.waitForFunction(() => {
      const table = document.querySelector('.si-data-table[aria-label="products.list 数据表"]');
      return table?.innerText.includes("3/3") ?? false;
    }, null, { timeout: 10_000 });
    await waitForW2TableTotal(page, "products.list", W2_EXPECTED.parentGroups + W2_EXPECTED.ungroupedSkus);
    const metrics = await readW2TableMetrics(page, "products.list");
    const row = page.locator(`${w2DataTableSelector("products.list")} tbody tr[data-row-id]`).filter({ hasText: "Synthetic grouped product 000" }).first();
    const selectedRowId = await row.getAttribute("data-row-id");
    await row.click();
    const panel = page.locator(".si-drawer");
    await panel.waitFor({ state: "visible", timeout: 15_000 });
    const detail = panel.locator(".si-product-detail");
    await detail.waitFor({ state: "visible", timeout: 10_000 });
    const inventoryHeading = await detail.getByText("变体库存", { exact: true }).isVisible();
    const selectedTitle = await detail.locator("h3").innerText();
    const selectedHandle = await detail.locator(".si-product-detail-handle code").innerText();
    const variantSkuIds = await detail.locator('.si-data-table[aria-label="products.variant-stock 数据表"] tbody tr[data-row-id]').evaluateAll((rows) => rows.map((item) => item.getAttribute("data-row-id") ?? ""));
    const expectedVariantSkuIds = ["SYN-P000-CH-01", "SYN-P000-CH-02", "SYN-P000-CH-03"];
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden", timeout: 10_000 });
    const passed = pagination.passed && metrics.total === W2_EXPECTED.products
      && await checkbox.isChecked() && selectedRowId === "group-000"
      && selectedTitle === "Synthetic grouped product 000" && selectedHandle === "group-000"
      && inventoryHeading && JSON.stringify(variantSkuIds) === JSON.stringify(expectedVariantSkuIds);
    return { passed, evidence: { pagination, parentOnlyTotal: metrics.total, selectedRowId, selectedTitle, selectedHandle, productDrawerShowsStock: inventoryHeading, variantSkuIds, expectedVariantSkuIds } };
  });

  await attemptW2("EDM table paginates and parent-only UI hides child SKU rows", "ui", async () => {
    await clickProjectTab(page, "EDM");
    const checkbox = page.getByRole("checkbox", { name: "仅展示父 SKU", exact: true });
    if (await checkbox.isChecked()) await checkbox.uncheck();
    await waitForW2Table(page, "edm.images");
    const pagination = await exerciseW2Pagination(page, "edm.images", W2_EXPECTED.totalSkus);
    await checkbox.check();
    await page.waitForFunction(() => {
      const table = document.querySelector('.si-data-table[aria-label="edm.images 数据表"]');
      return table?.querySelector(".si-pagination-count")?.textContent?.includes("/ 80") ?? false;
    }, null, { timeout: 10_000 });
    await waitForW2TableTotal(page, "edm.images", W2_EXPECTED.parentGroups + W2_EXPECTED.ungroupedSkus);
    const metrics = await readW2TableMetrics(page, "edm.images");
    const rowIds = await page.locator(`${w2DataTableSelector("edm.images")} tbody tr[data-row-id]`).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id") ?? ""));
    const childrenVisible = rowIds.some((value) => /-CH-\d{2}$/u.test(value));
    const passed = pagination.passed && metrics.total === W2_EXPECTED.products && await checkbox.isChecked() && !childrenVisible;
    return { passed, evidence: { pagination, parentOnlyTotal: metrics.total, childrenVisible } };
  });

  await attemptW2("Content table renders real packaged rows and advances pagination", "ui", async () => {
    await clickProjectTab(page, "内容");
    await waitForW2Table(page, "content.blog");
    const pagination = await exerciseW2Pagination(page, "content.blog", W2_EXPECTED.blogsBeforeRefresh);
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
    await page.waitForFunction(() => {
      const table = document.querySelector('.si-data-table[aria-label="content.blog 数据表"]');
      return table?.querySelector(".si-pagination-count")?.textContent?.includes("/ 2") ?? false;
    }, null, { timeout: 20_000 });
    const uiKpi = await page.locator(".si-content-kpis").innerText();
    const schemaKpi = await page.evaluate(async (projectId) => {
      const summary = await window.siteindex.content.summary(projectId);
      return summary.kpis.find((item) => item.key === "no_schema")?.value ?? null;
    }, W2_PROJECT_ID);
    const table = await readW2TableMetrics(page, "content.blog");
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
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Packaged acceptance must run on an ephemeral GitHub Actions Windows runner to isolate APPDATA safely.");
  }
  if (!APP_DATA_ROOT) throw new Error("The GitHub Actions Windows runner did not provide APPDATA.");
  if (!OUTPUT_DIR) throw new Error("SITEINDEX_ACCEPTANCE_OUTPUT is not configured.");
  if (hasInstalledSiteIndex()) throw new Error("The Windows runner already has a SiteIndex install; refusing to touch it.");
  if (await exists(APP_DATA_DIR)) throw new Error("The Windows runner already has SiteIndex user data; refusing to alter it.");
  const oldInstaller = path.resolve(process.argv[2] || "");
  const candidateInstaller = path.resolve(process.argv[3] || "");
  if (!oldInstaller || !candidateInstaller || !(await exists(oldInstaller)) || !(await exists(candidateInstaller))) {
    throw new Error("The official and candidate installers must both exist.");
  }
  const actualOldHash = await fileSha256(oldInstaller);
  assert(actualOldHash === OLD_RELEASE.sha256, `official ${OLD_RELEASE.tag} installer matches pinned GitHub digest`, {
    tag: OLD_RELEASE.tag,
    commit: OLD_RELEASE.commit,
    assetId: OLD_RELEASE.assetId,
    sha256: actualOldHash,
  });
  report.candidateInstallerSha256 = await fileSha256(candidateInstaller);
  if (HOSTED_UPDATE) {
    assert(report.candidateUpdateMetadataVerified,
      "published latest.yml version, installer filename, and SHA512 match the candidate EXE");
    assert(Boolean(report.candidateReleaseWorkflowRunId && report.candidateReleaseArtifactId),
      "candidate installer is bound to the successful tag-triggered Release run and its Windows artifact", {
        workflowRunId: report.candidateReleaseWorkflowRunId,
        artifactId: report.candidateReleaseArtifactId,
        artifactDigest: report.candidateReleaseArtifactSha256,
      });
    assert(report.candidateReleaseCommit === report.candidateSourceCommit,
      "candidate Release tag commit matches the downloaded installer provenance", {
        releaseCommit: report.candidateReleaseCommit,
        candidateSourceCommit: report.candidateSourceCommit,
      });
    assert(report.candidateReleaseAssetSha256 === report.candidateInstallerSha256,
      "candidate installer SHA256 matches the published Release asset digest", {
        releaseAssetId: report.candidateReleaseAssetId,
        expectedSha256: report.candidateReleaseAssetSha256,
        actualSha256: report.candidateInstallerSha256,
      });
    assert(report.candidateReleaseArtifactExeSha256 === report.candidateInstallerSha256,
      "published Release installer SHA256 matches the exact Windows artifact from its Release run", {
        releaseArtifactId: report.candidateReleaseArtifactId,
        artifactSha256: report.candidateReleaseArtifactExeSha256,
        releaseAssetSha256: report.candidateInstallerSha256,
      });
  }
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
  currentStage = `${OLD_RELEASE.tag} installation`;
  await install(oldInstaller);
  assert(await exists(path.join(INSTALL_DIR, "SiteIndex.exe")), `${OLD_RELEASE.tag} installed into dedicated runner directory`);
  report.installerStartedAppBeforeHarness = installedAppProcessCount() > 0;
  stopInstalledAppProcesses();
  await writeRunnerSettings();

  currentStage = `${OLD_RELEASE.tag} packaged launch`;
  let page = await launchInstalledApp({ executablePath: path.join(INSTALL_DIR, "SiteIndex.exe"), trace: HOSTED_UPDATE });
  const oldState = await appState(page);
  assert(oldState.version === OLD_RELEASE.version, `baseline packaged app reports ${OLD_RELEASE.tag} through preload IPC`, { version: oldState.version });
  assert(oldState.projectIds.includes("synthetic-legacy-project") && oldState.projectCount === 1, `${OLD_RELEASE.tag} discovers synthetic legacy project`, {
    projectCount: oldState.projectCount,
    syntheticProjectFound: oldState.projectIds.includes("synthetic-legacy-project"),
    syntheticSkuCount: oldState.activeSkuCounts[0] ?? 0,
  });
  const oldSettings = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  assert(oldState.settings.projects_root === PROJECTS_ROOT, `${OLD_RELEASE.tag} loads the project-root setting from the runner profile`);
  if (HOSTED_UPDATE) {
    currentStage = "GitHub hosted update check, download, and install";
    page = await requestHostedUpdate(page);
    candidateInstalled = true;
    assert(report.updaterRestart.detected, "NSIS update install relaunched the candidate application", report.updaterRestart);
  } else {
    await stopApplication();
    currentStage = "candidate installer upgrade";
    await install(candidateInstaller);
    candidateInstalled = true;
    assert(await exists(path.join(INSTALL_DIR, "SiteIndex.exe")), "candidate installer upgraded the same installation directory");
    stopInstalledAppProcesses();
    currentStage = `v${CANDIDATE_VERSION} packaged launch and upgrade persistence`;
    page = await launchInstalledApp({ executablePath: path.join(INSTALL_DIR, "SiteIndex.exe"), trace: true });
  }
  const syntheticSite = await startSyntheticSite();
  report.w2Acceptance.seed = await makeW2SyntheticProject(path.join(PROJECTS_ROOT, W2_PROJECT_ID), syntheticSite.origin);
  const candidateState = await appState(page);
  assert(candidateState.version === CANDIDATE_VERSION, "upgraded packaged app reports candidate version through preload IPC", { version: candidateState.version });
  const candidateProfileIsolated = candidateState.settings.projects_root === PROJECTS_ROOT;
  if (HOSTED_UPDATE && report.updaterRestart.harnessRelaunchedForIpc) {
    report.updaterRestart.harnessProfileVerified = candidateProfileIsolated;
    assert(candidateProfileIsolated,
      "harness-reopened candidate uses the isolated temporary profile; original updater-launched profile remains unverified",
      { harnessProfileVerified: candidateProfileIsolated, originalRestartProfile: "unknown" });
  } else {
    if (HOSTED_UPDATE) report.updaterRestart.originalRestartProfile = candidateProfileIsolated ? "verified-isolated" : "profile-mismatch";
    assert(candidateProfileIsolated,
      HOSTED_UPDATE ? "original updater-restarted candidate uses the isolated temporary profile" : "candidate installer app uses the isolated temporary profile",
      { profileMatchesTemporaryRoot: candidateProfileIsolated, originalRestartProfile: report.updaterRestart.originalRestartProfile });
  }
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
    `- Candidate Release commit / asset: \`${report.candidateReleaseCommit ?? "n/a"}\` / \`${report.candidateReleaseAssetId ?? "n/a"}\``,
    `- Candidate Release asset SHA256: \`${report.candidateReleaseAssetSha256 ?? "n/a"}\``,
    `- Candidate Release run / Windows artifact: \`${report.candidateReleaseWorkflowRunId ?? "n/a"}\` / \`${report.candidateReleaseArtifactId ?? "n/a"}\``,
    `- Candidate artifact ZIP SHA256 / installer SHA256: \`${report.candidateReleaseArtifactSha256 ?? "n/a"}\` / \`${report.candidateReleaseArtifactExeSha256 ?? "n/a"}\``,
    `- Update mode: ${report.updateMode}`,
    `- User data isolation: ${report.userDataIsolation}`,
    `- Installer launched app before harness: ${report.installerStartedAppBeforeHarness ?? "not checked"}`,
    `- Updater restart: ${JSON.stringify(report.updaterRestart)}`,
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
