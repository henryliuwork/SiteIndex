import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } from "electron";
import { createCoreService, pathsForProject } from "@siteindex/core";
import {
  isValidMediaSkuRecoveryPartition,
  PATHS,
  type AppSettings,
  type JobProgress,
  type JobResult,
  type ProjectId,
} from "@siteindex/shared";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAppHandlers } from "./ipc/app.js";
import { createEdmHandlers } from "./ipc/edm.js";
import { createJobsHandlers } from "./ipc/jobs.js";
import { createMediaHandlers } from "./ipc/media.js";
import { createHandlerRegistry, serializeIpcError } from "./ipc-registry.js";
import { createJobManager } from "./job-manager.js";
import { createWindowManager } from "./window-manager.js";
import { createWordPressCredentialVault } from "./wordpress-credential-vault.js";
import type { WordPressCredentialInput } from "../shared/wordpress-credential-types.js";
import { createWordPressMediaCredentialProvider } from "./wordpress-media-credential-provider.js";
import { ipcChannel } from "../shared/ipc-contract.js";

type ProductionPhase = "success" | "auth-401" | "forbidden-403" | "post-lost" | "retry";
type ExpectedSkuStatus = "uploaded" | "recorded" | "skipped_has_url" | "failed" | "unknown" | "not_started" | "reused";

interface PhaseReport {
  status: "passed" | "failed";
  phase: ProductionPhase;
  failureCode?: string;
  checks?: Record<string, boolean | number | string>;
}

interface FixtureSku {
  sku: string;
  imagePath: string | null;
}

const FIXTURE_CASES: Record<
  ProductionPhase,
  { projectId: string; rows: FixtureSku[]; expected: Record<ExpectedSkuStatus, number> }
> = {
  success: {
    projectId: "synthetic-media-success",
    rows: [
      { sku: "synthetic-upload-a", imagePath: "/success-a.webp" },
      { sku: "synthetic-record-png", imagePath: "/record.png" },
      { sku: "synthetic-skip-ledger", imagePath: "/success-b.webp" },
      { sku: "synthetic-no-image", imagePath: null },
      { sku: "synthetic-source-404", imagePath: "/missing.webp" },
      { sku: "synthetic-after-row-error", imagePath: "/success-c.webp" },
    ],
    expected: { uploaded: 2, recorded: 1, skipped_has_url: 1, failed: 2, unknown: 0, not_started: 0, reused: 0 },
  },
  "auth-401": {
    projectId: "synthetic-media-auth401",
    rows: [
      { sku: "synthetic-auth401-a", imagePath: "/success-a.webp" },
      { sku: "synthetic-auth401-b", imagePath: "/success-b.webp" },
    ],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 1, unknown: 0, not_started: 1, reused: 0 },
  },
  "forbidden-403": {
    projectId: "synthetic-media-forbidden403",
    rows: [
      { sku: "synthetic-forbidden-a", imagePath: "/success-a.webp" },
      { sku: "synthetic-forbidden-b", imagePath: "/success-b.webp" },
    ],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 1, unknown: 0, not_started: 1, reused: 0 },
  },
  "post-lost": {
    projectId: "synthetic-media-postlost",
    rows: [{ sku: "synthetic-post-lost", imagePath: "/success-a.webp" }],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 1, not_started: 0, reused: 0 },
  },
  retry: {
    projectId: "synthetic-media-postlost",
    rows: [{ sku: "synthetic-post-lost", imagePath: "/success-a.webp" }],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 0, not_started: 0, reused: 1 },
  },
};

const WEBP_BYTES = Buffer.from("UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEB8w/wKCIv9HCwFB0XXLBXwU1LRtwOI36YjofxwA", "base64");
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing-${name.toLowerCase()}`);
  return value;
}

function parsePhase(value: string | undefined): ProductionPhase {
  if (
    value === "success" ||
    value === "auth-401" ||
    value === "forbidden-403" ||
    value === "post-lost" ||
    value === "retry"
  ) {
    return value;
  }
  throw new Error("invalid-phase");
}

function credentialCanaries(seed: string): string[] {
  const credentials = [
    { username: `fixture-user-${seed}`, applicationPassword: `fixture-secret-${seed}` },
    { username: `fixture-forbidden-${seed}`, applicationPassword: `fixture-forbidden-secret-${seed}` },
  ];
  return credentials.flatMap(({ username, applicationPassword }) => [
    username,
    applicationPassword,
    `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`,
  ]);
}

function phaseCredential(phase: ProductionPhase, seed: string): WordPressCredentialInput {
  if (phase === "auth-401")
    return {
      siteUrl: requiredEnvironment("SITEINDEX_MEDIA_E2E_WP_ORIGIN"),
      username: `fixture-user-${seed}`,
      applicationPassword: `wrong-secret-${seed}`,
    };
  if (phase === "forbidden-403")
    return {
      siteUrl: requiredEnvironment("SITEINDEX_MEDIA_E2E_WP_ORIGIN"),
      username: `fixture-forbidden-${seed}`,
      applicationPassword: `fixture-forbidden-secret-${seed}`,
    };
  return {
    siteUrl: requiredEnvironment("SITEINDEX_MEDIA_E2E_WP_ORIGIN"),
    username: `fixture-user-${seed}`,
    applicationPassword: `fixture-secret-${seed}`,
  };
}

function appSettings(root: string): AppSettings {
  return {
    device_id: "synthetic-device",
    device_name: "Synthetic Desktop",
    projects_root: path.join(root, "projects"),
    extra_projects: [],
    cache_dir: path.join(root, "cache"),
    browser: { channel: "msedge", executable_path: null },
    notify: { on_failure: false, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [],
    conflict_patterns: [],
  };
}

function projectPathFor(root: string, projectId: string): string {
  return path.join(root, "projects", projectId);
}

async function writeFixtureProject(root: string, projectId: string, rows: readonly FixtureSku[]): Promise<string> {
  const projectPath = projectPathFor(root, projectId);
  const sitePath = path.join(projectPath, PATHS.site);
  try {
    await readFile(sitePath, "utf8");
    return projectPath;
  } catch {
    // The isolated test project is generated from the committed synthetic fixture below.
  }
  await mkdir(path.dirname(projectPath), { recursive: true });
  await cp(
    path.join(requiredEnvironment("SITEINDEX_MEDIA_E2E_REPO_ROOT"), "fixtures", "expected", "project"),
    projectPath,
    { recursive: true },
  );
  const site = JSON.parse(await readFile(sitePath, "utf8")) as Record<string, any>;
  site.domain = "synthetic.example.test";
  site.base_url = requiredEnvironment("SITEINDEX_MEDIA_E2E_WP_ORIGIN");
  site.brand = { name: "Synthetic", tagline: "Synthetic fixture", voice: "Synthetic", audience: "Synthetic", usp: [] };
  site.crawl.feed_url = [];
  site.crawl.rate_limit_ms = 0;
  site.edm = { ...site.edm, image_host: { type: "wordpress" } };
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`, "utf8");

  const date = "2026-11-12";
  const skus = rows.map(({ sku, imagePath }, index) => ({
    sku,
    product_id: `synthetic-product-${index}`,
    handle: `synthetic-product-${index}`,
    title: `Synthetic product ${index}`,
    variant_title: null,
    url: `https://products.example.test/${sku}`,
    category: "Synthetic",
    categories: ["Synthetic"],
    category_source: "feed",
    price: 12.5,
    compare_at_price: null,
    currency: "USD",
    image_url: imagePath ? `${requiredEnvironment("SITEINDEX_MEDIA_E2E_IMAGE_ORIGIN")}${imagePath}` : null,
    additional_images: [],
    gtin: null,
    mpn: null,
    brand: "Synthetic",
    status: "active",
    first_seen: date,
    last_seen: date,
    updated_at: date,
  }));
  const latest = rows.map(({ sku }) => ({
    sku,
    stock_status: "in_stock",
    qty: 4,
    since: date,
    checked_at: `${date}T12:00:00.000Z`,
  }));
  await writeFile(path.join(projectPath, PATHS.skus), `${skus.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await writeFile(
    path.join(projectPath, PATHS.inventoryLatest),
    `${latest.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  const mediaLedgerRows = ["sku,image_role,image_url,alt_text,source,width,height,updated_at,media_id,source_hash"];
  if (projectId === FIXTURE_CASES.success.projectId) {
    mediaLedgerRows.push(
      "synthetic-skip-ledger,main,https://images.example.test/already-set.jpg,Synthetic,manual,100,100,2026-11-12,existing-media,null",
    );
  }
  await writeFile(path.join(projectPath, PATHS.skuMedia), `${mediaLedgerRows.join("\n")}\n`, "utf8");
  await writeFile(path.join(projectPath, PATHS.runs), "", "utf8");
  return projectPath;
}

function phaseResultPath(): string {
  return path.resolve(requiredEnvironment("SITEINDEX_MEDIA_E2E_PHASE_RESULT"));
}

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 30_000,
  stage = "ui",
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${stage}-timeout`);
}

function countStatuses(result: JobResult): Record<ExpectedSkuStatus, number> {
  const counts: Record<ExpectedSkuStatus, number> = {
    uploaded: 0,
    recorded: 0,
    skipped_has_url: 0,
    failed: 0,
    unknown: 0,
    not_started: 0,
    reused: 0,
  };
  if (result.job !== "media" || !isValidMediaSkuRecoveryPartition(result)) return counts;
  for (const skuResult of result.media_results) counts[skuResult.status] += 1;
  counts.unknown = result.media_unknown_skus.length;
  counts.not_started = result.media_not_started_skus.length;
  return counts;
}

async function startProductionPackagedWindow(
  projectId: string,
  windowManager: ReturnType<typeof createWindowManager>,
): Promise<BrowserWindow> {
  windowManager.registerContentSecurityPolicy();
  const window = await windowManager.createMainWindow();
  const target = `#/p/${encodeURIComponent(projectId)}/edm`;
  await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(target)}`);
  await waitFor(
    () => window.webContents.executeJavaScript("document.body.innerText"),
    (text) => typeof text === "string" && text.includes("SKU 宣传图") && !text.includes("正在加载项目信息"),
    30_000,
    "edm-page-ready",
  );
  return window;
}

function makeSettingsHandlers(
  settings: AppSettings,
  uiStateByProject: Map<string, { columns: Record<string, string[]>; page_sizes: Record<string, 20 | 50 | 100> }>,
) {
  return {
    "settings.get": async () => settings,
    "uiState.get": async (id: unknown) => uiStateByProject.get(String(id)) ?? { columns: {}, page_sizes: {} },
    "uiState.set": async (id: unknown, patch: unknown) => {
      const current = uiStateByProject.get(String(id)) ?? { columns: {}, page_sizes: {} };
      const update = typeof patch === "object" && patch !== null ? (patch as Record<string, unknown>) : {};
      const next = {
        columns: {
          ...current.columns,
          ...(typeof update.columns === "object" && update.columns ? (update.columns as Record<string, string[]>) : {}),
        },
        page_sizes: {
          ...current.page_sizes,
          ...(typeof update.page_sizes === "object" && update.page_sizes
            ? (update.page_sizes as Record<string, 20 | 50 | 100>)
            : {}),
        },
      };
      uiStateByProject.set(String(id), next);
      return next;
    },
  };
}

async function readCsvRowCount(filePath: string): Promise<number> {
  const contents = await readFile(filePath, "utf8");
  return contents.split(/\r?\n/u).filter((line) => line.trim()).length - 1;
}

async function executeMediaUiPhase(phase: ProductionPhase): Promise<PhaseReport> {
  const root = path.resolve(requiredEnvironment("SITEINDEX_MEDIA_E2E_ROOT"));
  const seed = requiredEnvironment("SITEINDEX_MEDIA_E2E_SEED");
  if (!/^[a-f0-9]{32}$/u.test(seed)) throw new Error("invalid-seed");
  const fixture = FIXTURE_CASES[phase];
  const projectPath = await writeFixtureProject(root, fixture.projectId, fixture.rows);
  const settings = appSettings(root);
  const projectEntry = { id: fixture.projectId as ProjectId, path: projectPath };
  const entries = [projectEntry];
  const core = createCoreService({
    resolveProject: (id) => {
      const found = entries.find((entry) => entry.id === id);
      if (!found) throw new Error("fixture-project-not-found");
      return found.path;
    },
    listRegisteredProjects: async () => entries,
    deviceId: settings.device_id,
    deviceName: settings.device_name,
    cacheDir: settings.cache_dir,
    templateDir: path.join(process.resourcesPath, "templates", "project"),
  });
  const projectMap = new Map(entries.map((entry) => [entry.id, entry.path]));
  const credentialVault = createWordPressCredentialVault({
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
    homeDirectory: app.getPath("home"),
    safeStorage: {
      isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
      decryptStringAsync: (value) => safeStorage.decryptStringAsync(value),
    },
    testOnlyAllowLoopbackHttp: true,
  });
  await credentialVault.save(phaseCredential(phase, seed));
  const getWordPressCredential = createWordPressMediaCredentialProvider({
    getProject: async (id) => core.projects.get(id),
    vault: credentialVault,
  });
  let windowManager: ReturnType<typeof createWindowManager> | null = null;
  let finishedResolver: ((result: JobResult) => void) | null = null;
  let progressCount = 0;
  const finished = new Promise<JobResult>((resolve) => {
    finishedResolver = resolve;
  });
  const manager = createJobManager({
    workerPath: path.join(app.getAppPath(), "out", "main", "job-worker.js"),
    getSettings: async () => settings,
    isMediaJobReady: () => true,
    testOnlyAllowLoopbackHttp: true,
    getWordPressCredential,
    resolveProject: async (id) => projectMap.get(id) ?? projectPath,
    fork: (modulePath) =>
      utilityProcess.fork(modulePath, [], { serviceName: "SiteIndex synthetic media production E2E" }),
    emitProgress: (progress: JobProgress) => {
      progressCount += 1;
      windowManager?.sendToWindows(ipcChannel("jobs.onProgress"), progress);
    },
    emitFinished: (result) => {
      windowManager?.sendToWindows(ipcChannel("jobs.onFinished"), result);
      finishedResolver?.(result);
    },
    notify: () => undefined,
  });

  let mediaInvokeCount = 0;
  let requestPayloadContainsCredential = false;
  const projectHandlers = {
    "projects.list": async () => [(await core.projects.get(projectEntry.id)).summary],
    "projects.get": async (id: unknown) => core.projects.get(id as ProjectId),
  };
  const mediaHandlers = createMediaHandlers({
    jobs: manager,
    projects: {
      resolveProject: (id: ProjectId) => projectMap.get(id) ?? projectPath,
      ensureProject: async () => projectEntry,
      refresh: async () => entries,
    },
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== fixture.projectId)
        throw Object.assign(new Error("Synthetic project not registered."), { code: "PROJECT_NOT_FOUND" });
      return callback(fixture.projectId as ProjectId);
    },
  } as any);
  const productionPrepare = mediaHandlers["media.prepare"];
  if (!productionPrepare) throw new Error("media-handler-missing");
  const instrumentedMediaHandlers = {
    ...mediaHandlers,
    "media.prepare": async (...args: unknown[]) => {
      mediaInvokeCount += 1;
      const serialized = JSON.stringify(args);
      requestPayloadContainsCredential = credentialCanaries(seed).some((value) => serialized.includes(value));
      return productionPrepare(...args);
    },
  };
  const settingsHandlers = makeSettingsHandlers(settings, new Map());
  const edmHandlers = createEdmHandlers({
    core,
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== fixture.projectId)
        throw Object.assign(new Error("Synthetic project not registered."), { code: "PROJECT_NOT_FOUND" });
      return callback(fixture.projectId as ProjectId);
    },
    isEdmExportIndexReady: () => false,
  } as any);
  const jobsHandlers = createJobsHandlers({
    jobs: manager,
    projects: { resolveProject: (id: ProjectId) => projectMap.get(id) ?? projectPath },
  } as any);
  const scheduleHandlers = {
    "schedule.get": async (id: unknown) => core.schedule.get(id as ProjectId),
    "schedule.status": async () => ({ mode: "resident", authorization_required: false }),
    "runner.get": async (id: unknown) => core.runner.get(id as ProjectId),
  };
  const registry = createHandlerRegistry({
    ...createAppHandlers(),
    ...settingsHandlers,
    ...projectHandlers,
    ...edmHandlers,
    ...jobsHandlers,
    ...scheduleHandlers,
    ...instrumentedMediaHandlers,
  });
  for (const [channel, handler] of registry) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    });
  }

  windowManager = createWindowManager({
    mainDirectory: path.join(app.getAppPath(), "out", "main"),
    fallbackPath: path.join(app.getAppPath(), "out", "renderer", "fallback.html"),
    devUiUrl: "http://127.0.0.1:5174",
    initiallyHidden: true,
    shouldHideOnClose: () => false,
    isShuttingDown: () => false,
    requestQuit: () => app.quit(),
  });
  const window = await startProductionPackagedWindow(fixture.projectId, windowManager);
  const expectedSelectionCount = fixture.rows.length;
  await window.webContents.executeJavaScript(
    `(() => { const select = [...document.querySelectorAll('input[type="checkbox"]')].find((item) => item.getAttribute('aria-label') === '选择当前页全部行'); if (!select) throw new Error('selection-control-missing'); if (!select.checked) select.click(); })()`,
  );
  await waitFor(
    () => window.webContents.executeJavaScript("document.body.innerText"),
    (text) => typeof text === "string" && text.includes(`获取图片 URL（${expectedSelectionCount}）`),
    30_000,
    "media-action-ready",
  );
  const actionButtonFound = await window.webContents.executeJavaScript(
    `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${JSON.stringify(`获取图片 URL（${expectedSelectionCount}）`)}); if (!button || button.disabled) return false; button.click(); return true; })()`,
  );
  if (!actionButtonFound) throw new Error("media-action-button-unavailable");
  const result = await Promise.race([
    finished,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("job-timeout")), 90_000)),
  ]);
  const statuses = countStatuses(result);
  const statusesMatch = JSON.stringify(statuses) === JSON.stringify(fixture.expected);
  const expectedErrorCode =
    phase === "auth-401" ? "WP_AUTH_FAILED" : phase === "forbidden-403" ? "WP_FORBIDDEN" : undefined;
  const errorCodeMatches =
    expectedErrorCode === undefined
      ? result.media_error_code === undefined
      : result.media_error_code === expectedErrorCode;
  const runHistory = await manager.history(fixture.projectId as ProjectId, 20);
  const matchingRun = runHistory.find((row) => row.run_id === result.runId && row.job === "media");
  const runHistoryMatches = Boolean(matchingRun);
  const projectPaths = await pathsForProject(projectPath);
  const mediaLedgerRows = await readCsvRowCount(path.join(projectPath, projectPaths.skuMedia));
  const expectedMediaLedgerRows = phase === "success" ? 4 : phase === "retry" ? 1 : 0;
  const mediaLedgerMatches = mediaLedgerRows === expectedMediaLedgerRows;
  let crossPageRecovery = phase !== "post-lost";
  if (phase === "post-lost") {
    const runsHash = `#/p/${encodeURIComponent(fixture.projectId)}/runs`;
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(runsHash)}`);
    const runsText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) => typeof text === "string" && text.includes("运行") && text.includes("结果未知"),
      30_000,
      "runs-outcome-unknown",
    );
    const edmHash = `#/p/${encodeURIComponent(fixture.projectId)}/edm`;
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(edmHash)}`);
    const edmText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) => typeof text === "string" && text.includes("SKU 宣传图") && text.includes("结果未知"),
      30_000,
      "edm-outcome-unknown",
    );
    crossPageRecovery =
      typeof runsText === "string" &&
      runsText.includes("结果未知") &&
      typeof edmText === "string" &&
      edmText.includes("结果未知");
  }
  const rendererText = (await window.webContents.executeJavaScript("document.body.innerText")) as string;
  const canaries = credentialCanaries(seed);
  const rendererCanaryMatches = canaries.filter((value) => rendererText.includes(value)).length;
  const resultCanaryMatches = canaries.filter((value) => JSON.stringify(result).includes(value)).length;
  const actualHandlerPath = mediaInvokeCount === 1 && manager.running(fixture.projectId as ProjectId) === null;
  const requestPayloadSafe = !requestPayloadContainsCredential;
  const settledRendererText = await waitFor(
    () => window.webContents.executeJavaScript("document.body.innerText"),
    (text) =>
      typeof text === "string" &&
      (text.includes("图片准备任务结果") || (phase === "post-lost" && text.includes("最近一次图片处理记录"))),
    30_000,
    "media-result-rendered",
  );
  const uiRenderedActualMediaAction =
    typeof settledRendererText === "string" && settledRendererText.includes("获取图片 URL");
  const unknownStateMatches =
    phase === "post-lost"
      ? isValidMediaSkuRecoveryPartition(result) &&
        result.media_batch_state === "outcome_unknown" &&
        statuses.unknown === 1
      : phase !== "retry" ||
        (isValidMediaSkuRecoveryPartition(result) && result.media_results.some((item) => item.status === "reused"));
  const report: PhaseReport = {
    status: "passed",
    phase,
    checks: {
      packagedUiLoaded: rendererText.includes("SKU 宣传图"),
      actualEdmUiInvokedMediaPrepare: actualHandlerPath,
      utilityProcessProgressForwarded: progressCount > 0,
      coreJobResultPartitionMatches: statusesMatch,
      coreErrorCodeMatches: errorCodeMatches,
      runHistoryWritten: runHistoryMatches,
      mediaLedgerRowCount: mediaLedgerRows,
      mediaLedgerMatches,
      actualUiRenderedResult: uiRenderedActualMediaAction,
      requestPayloadContainsNoCredential: requestPayloadSafe,
      rendererCredentialCanaryMatches: rendererCanaryMatches,
      resultCredentialCanaryMatches: resultCanaryMatches,
      retryOrOutcomeUnknownMatches: unknownStateMatches,
      crossPageRecoveryAfterJob: crossPageRecovery,
      resultCounts: JSON.stringify(statuses),
      ...(expectedErrorCode ? { expectedAuthorizationCode: expectedErrorCode } : {}),
    },
  };
  if (
    !statusesMatch ||
    !errorCodeMatches ||
    !runHistoryMatches ||
    !mediaLedgerMatches ||
    !actualHandlerPath ||
    !requestPayloadSafe ||
    rendererCanaryMatches !== 0 ||
    resultCanaryMatches !== 0 ||
    !uiRenderedActualMediaAction ||
    !unknownStateMatches ||
    !crossPageRecovery
  )
    report.status = "failed";
  if (report.status === "failed") report.failureCode = "phase-assertion";
  await writeFile(phaseResultPath(), `${JSON.stringify(report)}\n`, "utf8");
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  await manager.shutdown();
  for (const channel of registry.keys()) ipcMain.removeHandler(channel);
  return report;
}

async function main(): Promise<void> {
  app.disableHardwareAcceleration();
  let phase: ProductionPhase = "success";
  try {
    if (!app.isPackaged) throw new Error("not-packaged");
    const productionMain = await readFile(path.join(app.getAppPath(), "out", "main", "index.js"), "utf8");
    if (!/isMediaJobReady:\s*\(\)\s*=>\s*false/u.test(productionMain)) throw new Error("production-gate-not-closed");
    if (!requiredEnvironment("LOCALAPPDATA")) throw new Error("isolated-local-appdata-missing");
    phase = parsePhase(process.env.SITEINDEX_MEDIA_E2E_PHASE);
    const root = path.resolve(requiredEnvironment("SITEINDEX_MEDIA_E2E_ROOT"));
    await mkdir(path.join(root, "user-data"), { recursive: true });
    app.setPath("userData", path.join(root, "user-data"));
    await app.whenReady();
    const report = await executeMediaUiPhase(phase);
    if (report.status !== "passed") throw new Error(report.failureCode ?? "phase-failed");
    process.stdout.write(`media-production:${phase}:passed\n`);
    app.quit();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9-]{1,60}$/u.test(error.message) ? error.message : "phase-failed";
    await writeFile(
      phaseResultPath(),
      `${JSON.stringify({ status: "failed", phase, failureCode: code })}\n`,
      "utf8",
    ).catch(() => undefined);
    process.stderr.write(`media-production:${phase}:failed:${code}\n`);
    app.exit(1);
  }
}

void main();
