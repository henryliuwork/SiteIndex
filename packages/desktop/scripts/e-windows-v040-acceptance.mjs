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
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const OLD_RELEASE = {
  tag: "v0.3.0",
  commit: "9dca729763ff6474e9baf182aac01213c81430a9",
  sha256: "5b0ffb1e5c74b743c5938bd62349ef0b9fe69a87f05dfc8f56adf25c26f77bdd",
};
const CANDIDATE_VERSION = "0.4.0";
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
  versionOverride: CANDIDATE_VERSION,
  candidateArtifactSource: process.env.SITEINDEX_CANDIDATE_INSTALLER_URL
    ? "official-candidate-installer"
    : "runner-built-internal-candidate",
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

function record(name, passed, evidence = {}) {
  report.checks.push({ name, status: passed ? "passed" : "failed", evidence });
  if (!passed) throw new Error(`Acceptance assertion failed: ${name}`);
}

function assert(condition, name, evidence = {}) {
  record(name, Boolean(condition), evidence);
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
  const root = path.join(os.tmpdir(), `siteindex-e-v040-${randomUUID()}`);
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
      device_id: "e-v040-synthetic-runner",
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
    crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 0 },
    categories: { mode: "feed" },
    workspace_folders: [],
    schedule: disabledSchedule(),
  };
  await writeFile(path.join(directory, "index", "site.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(path.join(directory, "index", "catalog", "skus.jsonl"), '{"sku":"SYN-001","handle":"fixture-item","status":"active"}\n', "utf8");
  await writeFile(path.join(directory, "user-owned.txt"), "synthetic-data-survives-upgrade\n", "utf8");
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

async function safeCandidateScreenshot(page) {
  if (!OUTPUT_DIR) return;
  await mkdir(OUTPUT_DIR, { recursive: true });
  const visibleText = await page.locator("body").innerText();
  const containsRunnerPath = (APP_DATA_ROOT && visibleText.includes(APP_DATA_ROOT)) || visibleText.includes(TEST_ROOT);
  if (containsRunnerPath) {
    report.visualEvidence = { screenshotCreated: false, reason: "synthetic-runner-path-visible" };
    return;
  }
  await page.screenshot({ path: path.join(OUTPUT_DIR, "v040-synthetic-project-center.png"), fullPage: true });
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

  currentStage = "v0.4.0 packaged launch and upgrade persistence";
  page = await launchInstalledApp({ executablePath: path.join(INSTALL_DIR, "SiteIndex.exe"), trace: true });
  const candidateState = await appState(page);
  assert(candidateState.version === CANDIDATE_VERSION, "upgraded packaged app reports candidate version through preload IPC", { version: candidateState.version });
  assert(candidateState.projectIds.includes("synthetic-legacy-project") && candidateState.projectCount === 1, "synthetic legacy project remains registered after upgrade", {
    projectCount: candidateState.projectCount,
    legacyProjectFound: candidateState.projectIds.includes("synthetic-legacy-project"),
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
  const finalState = await appState(page);
  assert(finalState.version === CANDIDATE_VERSION && finalState.projectCount >= 3, "candidate project center lists legacy, add-existing, and workspace projects", {
    projectCount: finalState.projectCount,
    syntheticLegacyPresent: finalState.projectIds.includes("synthetic-legacy-project"),
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
  report.result = failed ? "failed" : "passed";
  if (failed) report.failure = failed;
  await writeFile(path.join(OUTPUT_DIR, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summaryLines = [
    "## E · Windows v0.3.0 → v0.4.0 isolated packaged acceptance",
    "",
    `- Result: **${report.result}**`,
    `- Source commit: \`${report.sourceCommit ?? "unavailable"}\``,
    `- Candidate artifact: ${report.candidateArtifactSource}`,
    `- Candidate installer SHA256: \`${report.candidateInstallerSha256 ?? "unavailable"}\``,
    `- Windows build: \`${report.windows.build ?? report.windows.version}\``,
    `- Checks passed: ${report.checks.filter((check) => check.status === "passed").length}/${report.checks.length}`,
    `- Add-existing handler total: ${report.addExistingTrace?.handlerTotalMs ?? "not measured"} ms (target < 5000 ms)`,
    `- Screenshot: ${report.visualEvidence?.screenshotCreated ? "created" : report.visualEvidence?.reason ?? "not available"}`,
    "- Data: synthetic runner-only project; no real project or customer data used.",
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

if (failed) process.exitCode = 1;
