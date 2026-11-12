import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } from "electron";
import { createCoreService, pathsForProject } from "@siteindex/core";
import {
  isValidMediaSkuRecoveryPartition,
  PATHS,
  PENDING_HANDLERS,
  type AppSettings,
  type JobProgress,
  type JobResult,
  type ProjectId,
} from "@siteindex/shared";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAppHandlers } from "./ipc/app.js";
import { createEdmHandlers } from "./ipc/edm.js";
import { createJobsHandlers } from "./ipc/jobs.js";
import { createMediaHandlers } from "./ipc/media.js";
import { createHandlerRegistry, serializeIpcError } from "./ipc-registry.js";
import { createJobManager } from "./job-manager.js";
import { createEdmIndexSaveAs, type EdmIndexSaveDialogResult } from "./edm-index-save-as.js";
import { hasMediaProgressEvidence } from "./media-production-assertions.js";
import { isMediaPrepareReady } from "./media-readiness.js";
import { createWindowManager } from "./window-manager.js";
import { createWordPressCredentialVault } from "./wordpress-credential-vault.js";
import type { WordPressCredentialInput } from "../shared/wordpress-credential-types.js";
import { createWordPressMediaCredentialProvider } from "./wordpress-media-credential-provider.js";
import { ipcChannel } from "../shared/ipc-contract.js";

type ProductionPhase =
  | "success"
  | "auth-401"
  | "forbidden-403"
  | "post-lost"
  | "retry"
  | "post-429"
  | "retry-429"
  | "post-503"
  | "retry-503";
type ExpectedSkuStatus = "uploaded" | "recorded" | "skipped_has_url" | "failed" | "unknown" | "not_started" | "reused";
type PhaseStage =
  | "bootstrap"
  | "contract-ready"
  | "electron-ready"
  | "renderer-ready"
  | "media-rows-ready"
  | "media-selection-ready"
  | "media-action-ready"
  | "job-started"
  | "job-finished"
  | "report-ready"
  | "report-written"
  | "retry-history-verified"
  | "caught-error"
  | "report-write-failed";

interface PhaseReport {
  status: "passed" | "failed";
  phase: ProductionPhase;
  failureCode?: string;
  checks?: Record<string, boolean | number | string>;
}

interface EdmExportInvocation {
  kind: "resolved" | "rejected";
  status?: string;
  skuCount?: number;
  errorCode?: string;
  errorDetail?: string;
}

interface EdmExportSaveAsAcceptance {
  createdOutsideProject: boolean;
  cancellationDidNotCreateFile: boolean;
  projectConflictPreservedExistingFile: boolean;
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
      { sku: "synthetic-auth401-c", imagePath: "/success-c.webp" },
    ],
    expected: { uploaded: 1, recorded: 0, skipped_has_url: 0, failed: 1, unknown: 0, not_started: 1, reused: 0 },
  },
  "forbidden-403": {
    projectId: "synthetic-media-forbidden403",
    rows: [
      { sku: "synthetic-forbidden-a", imagePath: "/success-a.webp" },
      { sku: "synthetic-forbidden-b", imagePath: "/success-b.webp" },
      { sku: "synthetic-forbidden-c", imagePath: "/success-c.webp" },
    ],
    expected: { uploaded: 1, recorded: 0, skipped_has_url: 0, failed: 1, unknown: 0, not_started: 1, reused: 0 },
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
  "post-429": {
    projectId: "synthetic-media-post429",
    rows: [
      { sku: "synthetic-post-429", imagePath: "/success-a.webp" },
      { sku: "synthetic-post-429-next", imagePath: "/success-b.webp" },
    ],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 1, not_started: 1, reused: 0 },
  },
  "retry-429": {
    projectId: "synthetic-media-post429",
    rows: [{ sku: "synthetic-post-429", imagePath: "/success-a.webp" }],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 0, not_started: 0, reused: 1 },
  },
  "post-503": {
    projectId: "synthetic-media-post503",
    rows: [
      { sku: "synthetic-post-503", imagePath: "/success-a.webp" },
      { sku: "synthetic-post-503-next", imagePath: "/success-b.webp" },
    ],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 1, not_started: 1, reused: 0 },
  },
  "retry-503": {
    projectId: "synthetic-media-post503",
    rows: [{ sku: "synthetic-post-503", imagePath: "/success-a.webp" }],
    expected: { uploaded: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 0, not_started: 0, reused: 1 },
  },
};

const RECOVERY_RETRY_PHASES = new Set<ProductionPhase>(["retry", "retry-429", "retry-503"]);
const UNKNOWN_POST_PHASES = new Set<ProductionPhase>(["post-lost", "post-429", "post-503"]);

const WEBP_BYTES = Buffer.from("UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEB8w/wKCIv9HCwFB0XXLBXwU1LRtwOI36YjofxwA", "base64");
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing-${name.toLowerCase()}`);
  return value;
}

function reportPhaseStage(phase: ProductionPhase, stage: PhaseStage): void {
  process.stdout.write(`media-production:${phase}:stage:${stage}\n`);
}

function parsePhase(value: string | undefined): ProductionPhase {
  if (
    value === "success" ||
    value === "auth-401" ||
    value === "forbidden-403" ||
    value === "post-lost" ||
    value === "retry" ||
    value === "post-429" ||
    value === "retry-429" ||
    value === "post-503" ||
    value === "retry-503"
  ) {
    return value;
  }
  throw new Error("invalid-phase");
}

function credentialCanaries(seed: string): string[] {
  const username = `fixture-user-${seed}`;
  const applicationPassword = `fixture-secret-${seed}`;
  const pair = `${username}:${applicationPassword}`;
  return [
    username,
    applicationPassword,
    pair,
    Buffer.from(username).toString("base64"),
    Buffer.from(applicationPassword).toString("base64"),
    Buffer.from(pair).toString("base64"),
    `Basic ${Buffer.from(pair).toString("base64")}`,
  ];
}

function phaseCredential(phase: ProductionPhase, seed: string): WordPressCredentialInput {
  void phase;
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

async function writePhaseReport(report: unknown): Promise<void> {
  const targetPath = phaseResultPath();
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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

function expectedVisibleResultLabels(expected: Record<ExpectedSkuStatus, number>): string[] {
  const labels: Record<ExpectedSkuStatus, string> = {
    uploaded: "已上传",
    recorded: "原图 URL 已记录",
    skipped_has_url: "已有 URL，已跳过",
    failed: "失败",
    unknown: "结果未知",
    not_started: "已确认未开始",
    reused: "已复用",
  };
  return Object.entries(expected)
    .filter(([, count]) => count > 0)
    .map(([status]) => labels[status as ExpectedSkuStatus]);
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

async function invokePackagedEdmExport(window: BrowserWindow, projectId: string): Promise<EdmExportInvocation> {
  return (await window.webContents.executeJavaScript(`(async () => {
    try {
      const result = await window.siteindex.edm.exportIndex(${JSON.stringify(projectId)});
      return { kind: "resolved", status: result.status, skuCount: result.sku_count };
    } catch (error) {
      return {
        kind: "rejected",
        errorCode: error && typeof error === "object" ? error.code : undefined,
        errorDetail: error && typeof error === "object" ? error.detail : undefined,
      };
    }
  })()`)) as EdmExportInvocation;
}

async function runPackagedEdmExportSaveAsAcceptance(
  window: BrowserWindow,
  projectId: string,
  projectPath: string,
  root: string,
  chooseDialogResult: (result: EdmIndexSaveDialogResult) => void,
): Promise<EdmExportSaveAsAcceptance> {
  const exportDirectory = path.join(root, "edm-export");
  await mkdir(exportDirectory, { recursive: true });

  const generatedTarget = path.join(exportDirectory, "synthetic-edm-index.md");
  chooseDialogResult({ canceled: false, filePath: generatedTarget });
  const saved = await invokePackagedEdmExport(window, projectId);
  const savedContent = await readFile(generatedTarget, "utf8").catch(() => "");
  const createdOutsideProject =
    saved.kind === "resolved" &&
    saved.status === "created" &&
    typeof saved.skuCount === "number" &&
    saved.skuCount > 0 &&
    savedContent.startsWith("<!-- siteindex:generated:edm-sku-index:v1 -->\n") &&
    !savedContent.includes(projectPath);

  const cancelledTarget = path.join(exportDirectory, "cancelled-edm-index.md");
  chooseDialogResult({ canceled: true, filePath: cancelledTarget });
  const cancelled = await invokePackagedEdmExport(window, projectId);
  const cancelledContent = await readFile(cancelledTarget, "utf8").catch(() => null);
  const cancellationDidNotCreateFile =
    cancelled.kind === "resolved" && cancelled.status === "cancelled" && cancelledContent === null;

  const conflictTarget = path.join(projectPath, "synthetic-user-owned.md");
  const existingContent = "Synthetic user-owned content; keep unchanged.\n";
  await writeFile(conflictTarget, existingContent, "utf8");
  chooseDialogResult({ canceled: false, filePath: conflictTarget });
  const conflict = await invokePackagedEdmExport(window, projectId);
  const preservedContent = await readFile(conflictTarget, "utf8").catch(() => "");
  const projectConflictPreservedExistingFile =
    conflict.kind === "rejected" &&
    conflict.errorCode === "EDM_INDEX_CONFLICT" &&
    conflict.errorDetail === "EDM_INDEX_PROJECT_FILE_EXISTS" &&
    preservedContent === existingContent;

  return { createdOutsideProject, cancellationDidNotCreateFile, projectConflictPreservedExistingFile };
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
  let edmDialogResult: EdmIndexSaveDialogResult | null = null;
  const saveEdmSkuIndex = createEdmIndexSaveAs({
    defaultPath: path.join(root, "edm-export", path.basename(PATHS.edmSkuIndex)),
    showSaveDialog: async () => {
      const result = edmDialogResult;
      edmDialogResult = null;
      if (!result) throw new Error("synthetic-edm-dialog-result-missing");
      return result;
    },
  });
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
  let crossPageDuringJob = false;
  let jobCompletedAwayFromEdm = false;
  const workerOutputChunks: Buffer[] = [];
  const workerExitPromises: Promise<void>[] = [];
  const isRecoveryRetry = RECOVERY_RETRY_PHASES.has(phase);
  let harnessIsShuttingDown = false;
  let restartUnknownOutcomeRecoveredOnColdMount = !isRecoveryRetry;
  let retryReviewDialogConfirmed = !isRecoveryRetry;
  const finished = new Promise<JobResult>((resolve) => {
    finishedResolver = resolve;
  });
  const manager = createJobManager({
    workerPath: path.join(app.getAppPath(), "out", "main", "job-worker.js"),
    getSettings: async () => settings,
    isMediaJobReady: () => isMediaPrepareReady(core),
    testOnlyAllowLoopbackHttp: true,
    getWordPressCredential,
    resolveProject: async (id) => projectMap.get(id) ?? projectPath,
    fork: (modulePath) => {
      const child = utilityProcess.fork(modulePath, [], {
        serviceName: "SiteIndex synthetic media production E2E",
        stdio: "pipe",
      });
      child.stdout?.on("data", (chunk) => workerOutputChunks.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => workerOutputChunks.push(Buffer.from(chunk)));
      workerExitPromises.push(new Promise((resolve) => child.once("exit", () => resolve())));
      return child;
    },
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
  if (isRecoveryRetry) {
    const history = await manager.history(fixture.projectId as ProjectId, 20);
    const hasUnknownOutcome = history.some(
      (run) => run.job === "media" && run.media_unknown_skus?.includes(fixture.rows[0]!.sku),
    );
    if (!hasUnknownOutcome) throw new Error("retry-history-unknown-missing");
    reportPhaseStage(phase, "retry-history-verified");
  }

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
    projects: { resolveProject: (id: ProjectId) => projectMap.get(id) ?? projectPath },
    saveEdmSkuIndex,
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== fixture.projectId)
        throw Object.assign(new Error("Synthetic project not registered."), { code: "PROJECT_NOT_FOUND" });
      return callback(fixture.projectId as ProjectId);
    },
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
  const version = app.getVersion();
  const updateHandlers = {
    "updates.check": async () => ({ state: "idle" as const, current: version, latest: version }),
    "updates.download": async () => undefined,
    "updates.install": async () => undefined,
  };
  const registry = createHandlerRegistry({
    ...createAppHandlers(),
    ...settingsHandlers,
    ...projectHandlers,
    ...edmHandlers,
    ...jobsHandlers,
    ...scheduleHandlers,
    ...updateHandlers,
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
    isShuttingDown: () => harnessIsShuttingDown,
    requestQuit: () => app.quit(),
  });
  const window = await startProductionPackagedWindow(fixture.projectId, windowManager);
  reportPhaseStage(phase, "renderer-ready");
  const edmExportAcceptance =
    phase === "success"
      ? await runPackagedEdmExportSaveAsAcceptance(
          window,
          fixture.projectId,
          projectPath,
          root,
          (result) => {
            edmDialogResult = result;
          },
        )
      : null;
  const domSnapshotsInstalled = await window.webContents.executeJavaScript(`(() => {
    const state = { texts: [], overflowed: false };
    const capture = () => {
      if (state.texts.length >= 4096) { state.overflowed = true; return; }
      state.texts.push(document.documentElement?.innerText ?? "");
    };
    capture();
    const observer = new MutationObserver(capture);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.__siteIndexMediaDomScan = { state, observer };
    return true;
  })()`);
  if (!domSnapshotsInstalled) throw new Error("renderer-dom-scan-unavailable");
  if (isRecoveryRetry) {
    const recoveredText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) =>
        typeof text === "string" &&
        text.includes("最近一次图片处理记录") &&
        text.includes("结果未知") &&
        text.includes(fixture.rows[0]!.sku),
      30_000,
      "restart-history-unknown-recovery",
    );
    restartUnknownOutcomeRecoveredOnColdMount = typeof recoveredText === "string" && recoveredText.includes("结果未知");
  }
  const expectedSelectionCount = fixture.rows.length;
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        `document.querySelectorAll('input[type="checkbox"][aria-label^="选择第 "]').length`,
      ),
    (count) => typeof count === "number" && count >= expectedSelectionCount,
    30_000,
    "media-rows-ready",
  );
  reportPhaseStage(phase, "media-rows-ready");
  const progressListenerInstalled = await window.webContents.executeJavaScript(
    "(() => { if (!window.siteindex?.jobs?.onProgress) return false; window.__siteIndexMediaProgressCount = 0; window.siteindex.jobs.onProgress(() => { window.__siteIndexMediaProgressCount += 1; }); return true; })()",
  );
  if (!progressListenerInstalled) throw new Error("renderer-progress-listener-unavailable");
  const selectionScript = isRecoveryRetry
    ? `(() => { const sku = ${JSON.stringify(fixture.rows[0]!.sku)}; const row = [...document.querySelectorAll('tr')].find((item) => item.innerText.includes(sku)); const select = row?.querySelector('input[type="checkbox"]'); if (!select) throw new Error('recovery-selection-row-missing'); if (!select.checked) select.click(); })()`
    : `(() => { const select = [...document.querySelectorAll('input[type="checkbox"]')].find((item) => item.getAttribute('aria-label') === '选择当前页全部行'); if (!select) throw new Error('selection-control-missing'); if (!select.checked) select.click(); })()`;
  await window.webContents.executeJavaScript(selectionScript);
  reportPhaseStage(phase, "media-selection-ready");
  await waitFor(
    () => window.webContents.executeJavaScript("document.body.innerText"),
    (text) => typeof text === "string" && text.includes(`获取图片 URL（${expectedSelectionCount}）`),
    30_000,
    "media-action-ready",
  );
  reportPhaseStage(phase, "media-action-ready");
  const actionButtonFound = await window.webContents.executeJavaScript(
    `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${JSON.stringify(`获取图片 URL（${expectedSelectionCount}）`)}); if (!button || button.disabled) return false; button.click(); return true; })()`,
  );
  if (!actionButtonFound) throw new Error("media-action-button-unavailable");
  reportPhaseStage(phase, "job-started");
  if (isRecoveryRetry) {
    let dialogText: unknown;
    try {
      dialogText = await waitFor(
        () =>
          window.webContents.executeJavaScript(
            "[...document.querySelectorAll('[role=dialog]')].map((dialog) => dialog.innerText).join('\\n')",
          ),
        (text) => typeof text === "string" && text.includes("请先核对图片处理结果") && text.includes("可能再次上传"),
        30_000,
        "restart-retry-review-dialog",
      );
    } catch {
      const uiState = (await window.webContents.executeJavaScript(`(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')];
        const target = dialogs.find((item) => item.innerText.includes("请先核对图片处理结果"));
        const confirm = [...(target?.querySelectorAll('button') ?? [])].some((item) => item.textContent?.trim() === "已核对，继续处理");
        return { dialogCount: dialogs.length, targetDialog: Boolean(target), confirmButton: confirm, unknownVisible: document.body.innerText.includes("结果未知") };
      })()`)) as { dialogCount: number; targetDialog: boolean; confirmButton: boolean; unknownVisible: boolean };
      const failureCode = !uiState.unknownVisible
        ? "retry-ui-unknown-not-visible"
        : uiState.targetDialog
          ? "retry-dialog-missing-unknown"
          : uiState.dialogCount > 0
            ? "retry-other-dialog-open"
            : "retry-dialog-not-opened";
      throw new Error(failureCode);
    }
    if (typeof dialogText !== "string" || !dialogText.includes("可能再次上传")) {
      throw new Error("restart-retry-review-confirmation-missing");
    }
    retryReviewDialogConfirmed = await window.webContents.executeJavaScript(
      `(() => { const dialog = [...document.querySelectorAll('[role=dialog]')].find((item) => item.innerText.includes("请先核对图片处理结果") && item.innerText.includes("可能再次上传")); const button = [...(dialog?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === "已核对，继续处理"); if (!button || button.disabled) return false; button.click(); return true; })()`,
    );
    if (!retryReviewDialogConfirmed) throw new Error("restart-retry-review-confirm-unavailable");
  }
  const resultPromise = Promise.race([
    finished,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("job-timeout")), 90_000)),
  ]);
  if (phase === "post-lost") {
    await waitFor(
      () => window.webContents.executeJavaScript("window.__siteIndexMediaProgressCount ?? 0"),
      (count) => typeof count === "number" && count > 0,
      30_000,
      "renderer-progress-event",
    );
    if (!manager.running(fixture.projectId as ProjectId)) throw new Error("media-job-not-running-before-navigation");
    const runsHash = `#/p/${encodeURIComponent(fixture.projectId)}/runs`;
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(runsHash)}`);
    const activeRunsText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) => typeof text === "string" && text.includes("图片 URL 处理") && text.includes("运行中"),
      30_000,
      "runs-page-active-job",
    );
    const wasRunningOnRunsPage = manager.running(fixture.projectId as ProjectId) !== null;
    crossPageDuringJob =
      wasRunningOnRunsPage && typeof activeRunsText === "string" && activeRunsText.includes("运行中");
    await writeFile(path.join(root, "post-lost-ui-returned"), "ready\n", "utf8");
  }
  const result = await resultPromise;
  reportPhaseStage(phase, "job-finished");
  const rendererProgressCount = (await window.webContents.executeJavaScript(
    "window.__siteIndexMediaProgressCount ?? 0",
  )) as number;
  const progressEvidenceComplete = hasMediaProgressEvidence(progressCount, rendererProgressCount);
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
  const expectedMediaLedgerRows =
    phase === "success"
      ? 4
      : RECOVERY_RETRY_PHASES.has(phase) || phase === "auth-401" || phase === "forbidden-403"
        ? 1
        : 0;
  const mediaLedgerMatches = mediaLedgerRows === expectedMediaLedgerRows;
  let crossPageRecovery = false;
  let resultRecoveredOnRunsPage = false;
  let settledRendererText = "";
  if (phase === "post-lost") {
    const runsHash = `#/p/${encodeURIComponent(fixture.projectId)}/runs`;
    const runsText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) => typeof text === "string" && text.includes("结果未知"),
      30_000,
      "runs-outcome-unknown",
    );
    const hashAfterBackgroundCompletion = (await window.webContents.executeJavaScript("location.hash")) as string;
    jobCompletedAwayFromEdm =
      hashAfterBackgroundCompletion === runsHash &&
      manager.running(fixture.projectId as ProjectId) === null &&
      runsText.includes("结果未知");
    resultRecoveredOnRunsPage = jobCompletedAwayFromEdm;
    const edmHash = `#/p/${encodeURIComponent(fixture.projectId)}/edm`;
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(edmHash)}`);
    settledRendererText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) =>
        typeof text === "string" &&
        text.includes("SKU 宣传图") &&
        expectedVisibleResultLabels(fixture.expected).some((label) => text.includes(label)),
      30_000,
      "edm-outcome-unknown",
    );
    crossPageRecovery =
      jobCompletedAwayFromEdm &&
      typeof settledRendererText === "string" &&
      settledRendererText.includes("SKU 宣传图") &&
      settledRendererText.includes("结果未知");
  } else {
    settledRendererText = await waitFor(
      () => window.webContents.executeJavaScript("document.body.innerText"),
      (text) =>
        typeof text === "string" && expectedVisibleResultLabels(fixture.expected).some((label) => text.includes(label)),
      30_000,
      "media-result-rendered",
    );
  }
  const rendererText = (await window.webContents.executeJavaScript("document.body.innerText")) as string;
  const domScan = (await window.webContents.executeJavaScript(`(() => {
    const scan = window.__siteIndexMediaDomScan;
    scan?.observer?.disconnect();
    return scan?.state ?? { texts: [], overflowed: true };
  })()`)) as { texts: string[]; overflowed: boolean };
  const domText = domScan.texts.join("\n");
  const canaries = credentialCanaries(seed);
  const rendererCanaryMatches = canaries.filter(
    (value) => domText.includes(value) || rendererText.includes(value),
  ).length;
  const resultCanaryMatches = canaries.filter((value) => JSON.stringify(result).includes(value)).length;
  const actualHandlerPath = mediaInvokeCount === 1 && manager.running(fixture.projectId as ProjectId) === null;
  const requestPayloadSafe = !requestPayloadContainsCredential;
  const uiRenderedActualMediaAction =
    typeof settledRendererText === "string" &&
    expectedVisibleResultLabels(fixture.expected).some((label) => settledRendererText.includes(label));
  const unknownStateMatches = UNKNOWN_POST_PHASES.has(phase)
    ? isValidMediaSkuRecoveryPartition(result) &&
      result.media_batch_state === "outcome_unknown" &&
      statuses.unknown === 1
    : !RECOVERY_RETRY_PHASES.has(phase) ||
      (isValidMediaSkuRecoveryPartition(result) && result.media_results.some((item) => item.status === "reused"));
  const report: PhaseReport = {
    status: "passed",
    phase,
    checks: {
      packagedUiLoaded: rendererText.includes("SKU 宣传图"),
      actualEdmUiInvokedMediaPrepare: actualHandlerPath,
      utilityProcessProgressForwarded: progressCount > 0,
      rendererReceivedUtilityProcessProgress: rendererProgressCount > 0,
      progressEvidenceComplete,
      coreJobResultPartitionMatches: statusesMatch,
      coreErrorCodeMatches: errorCodeMatches,
      runHistoryWritten: runHistoryMatches,
      mediaLedgerRowCount: mediaLedgerRows,
      mediaLedgerMatches,
      actualUiRenderedResult: uiRenderedActualMediaAction,
      requestPayloadContainsNoCredential: requestPayloadSafe,
      rendererCredentialCanaryMatches: rendererCanaryMatches,
      rendererDomScanComplete: !domScan.overflowed,
      resultCredentialCanaryMatches: resultCanaryMatches,
      retryOrOutcomeUnknownMatches: unknownStateMatches,
      ...(isRecoveryRetry
        ? {
            restartUnknownOutcomeRecoveredOnColdMount,
            retryReviewDialogConfirmed,
          }
        : {}),
      ...(phase === "post-lost"
        ? {
            crossPageDuringActiveJob: crossPageDuringJob,
            jobCompletedAwayFromEdm,
            resultRecoveredOnRunsPage,
            crossPageRecoveryAfterJob: crossPageRecovery,
          }
        : {}),
      ...(edmExportAcceptance
        ? {
            edmIndexSaveAsCreatedOutsideProject: edmExportAcceptance.createdOutsideProject,
            edmIndexSaveAsCancellationDidNotCreateFile: edmExportAcceptance.cancellationDidNotCreateFile,
            edmIndexSaveAsConflictPreservedProjectFile: edmExportAcceptance.projectConflictPreservedExistingFile,
          }
        : {}),
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
    !progressEvidenceComplete ||
    !requestPayloadSafe ||
    rendererCanaryMatches !== 0 ||
    domScan.overflowed ||
    resultCanaryMatches !== 0 ||
    !uiRenderedActualMediaAction ||
    !unknownStateMatches ||
    (isRecoveryRetry && (!restartUnknownOutcomeRecoveredOnColdMount || !retryReviewDialogConfirmed)) ||
    (phase === "post-lost" && (!crossPageDuringJob || !jobCompletedAwayFromEdm || !crossPageRecovery)) ||
    (edmExportAcceptance &&
      (!edmExportAcceptance.createdOutsideProject ||
        !edmExportAcceptance.cancellationDidNotCreateFile ||
        !edmExportAcceptance.projectConflictPreservedExistingFile))
  )
    report.status = "failed";
  await manager.shutdown();
  await Promise.all(workerExitPromises);
  const workerOutput = Buffer.concat(workerOutputChunks);
  await writeFile(path.join(root, `worker-output-${phase}.bin`), workerOutput);
  const workerCanaryBytes = canaries.flatMap((value) => [Buffer.from(value, "utf8"), Buffer.from(value, "utf16le")]);
  const workerCredentialCanaryMatches = workerCanaryBytes.filter((value) => workerOutput.includes(value)).length;
  report.checks!.workerCredentialCanaryMatches = workerCredentialCanaryMatches;
  if (workerCredentialCanaryMatches > 0) report.status = "failed";
  if (report.status === "failed") report.failureCode = "phase-assertion";
  reportPhaseStage(phase, "report-ready");
  await writePhaseReport(report);
  reportPhaseStage(phase, "report-written");
  for (const channel of registry.keys()) ipcMain.removeHandler(channel);
  harnessIsShuttingDown = true;
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  return report;
}

async function main(): Promise<void> {
  app.disableHardwareAcceleration();
  let phase: ProductionPhase = "success";
  reportPhaseStage(phase, "bootstrap");
  try {
    if (!app.isPackaged) throw new Error("not-packaged");
    const productionMain = await readFile(path.join(app.getAppPath(), "out", "main", "index.js"), "utf8");
    if (
      !/isMediaJobReady:\s*\(\)\s*=>\s*isMediaPrepareReady\(mediaCore\)/u.test(productionMain) ||
      !/function\s+isMediaPrepareReady\(core,\s*pendingHandlers\s*=\s*PENDING_HANDLERS\)\s*\{\s*return\s+core\s*!==\s*null\s*&&\s*!pendingHandlers\.includes\("media\.prepare"\);/u.test(
        productionMain,
      )
    ) {
      throw new Error("production-readiness-guard-missing");
    }
    if (!requiredEnvironment("LOCALAPPDATA")) throw new Error("isolated-local-appdata-missing");
    phase = parsePhase(process.env.SITEINDEX_MEDIA_E2E_PHASE);
    if (PENDING_HANDLERS.includes("media.prepare")) throw new Error("shared-media-prepare-pending");
    reportPhaseStage(phase, "contract-ready");
    const root = path.resolve(requiredEnvironment("SITEINDEX_MEDIA_E2E_ROOT"));
    await mkdir(path.join(root, "user-data"), { recursive: true });
    app.setPath("userData", path.join(root, "user-data"));
    await app.whenReady();
    reportPhaseStage(phase, "electron-ready");
    const report = await executeMediaUiPhase(phase);
    if (report.status !== "passed") throw new Error(report.failureCode ?? "phase-failed");
    process.stdout.write(`media-production:${phase}:passed\n`);
    app.quit();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9-]{1,60}$/u.test(error.message) ? error.message : "phase-failed";
    reportPhaseStage(phase, "caught-error");
    try {
      await writePhaseReport({ status: "failed", phase, failureCode: code });
      reportPhaseStage(phase, "report-written");
    } catch {
      reportPhaseStage(phase, "report-write-failed");
    }
    process.stderr.write(`media-production:${phase}:failed:${code}\n`);
    app.exit(1);
  }
}

void main();
