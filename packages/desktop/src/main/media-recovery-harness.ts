import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } from "electron";
import { createServer, type Server } from "node:http";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathsForProject } from "@siteindex/core";
import { PATHS, isValidMediaSkuRecoveryPartition, type JobResult, type ProjectId } from "@siteindex/shared";
import { createHandlerRegistry, serializeIpcError } from "./ipc-registry.js";
import { createJobManager } from "./job-manager.js";
import { createJobsHandlers } from "./ipc/jobs.js";
import { createMediaHandlers } from "./ipc/media.js";
import { createWindowManager } from "./window-manager.js";
import { createWordPressCredentialVault, resolveWordPressCredentialDirectory } from "./wordpress-credential-vault.js";
import { createWordPressMediaCredentialProvider } from "./wordpress-media-credential-provider.js";
import { ipcChannel } from "../shared/ipc-contract.js";

const EXPECTED_SKUS = ["synthetic-media-a", "synthetic-media-b", "synthetic-media-c"] as const;
const FIXTURE_CREDENTIAL_USERNAME_PREFIX = "fixture-user-";
const FIXTURE_CREDENTIAL_PASSWORD_PREFIX = "fixture-secret-";
const WEBP_BYTES = Buffer.from(
  "UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEB8w/wKCIv9HCwFB0XXLBXwU1LRtwOI36YjofxwA",
  "base64",
);

interface HarnessInternalResult {
  status: "passed" | "failed";
  phase: "crash-worker" | "read-recovery";
  runId?: string;
  failureCode?: string;
  checks?: Record<string, boolean | number | string>;
}

function rootPath(): string {
  const value = process.env.SITEINDEX_MEDIA_E2E_ROOT;
  if (!value) throw new Error("Missing test root.");
  return path.resolve(value);
}

function isPathWithin(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function createE2eCredentialVault() {
  return createWordPressCredentialVault({
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
    homeDirectory: app.getPath("home"),
    safeStorage: {
      isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptStringAsync: (plainText) => safeStorage.encryptStringAsync(plainText),
      decryptStringAsync: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    },
    // The harness uses only its synthetic 127.0.0.1 WordPress server. Production never sets this override.
    testOnlyAllowLoopbackHttp: true,
  });
}

function reportPath(): string {
  const value = process.env.SITEINDEX_MEDIA_E2E_PHASE_RESULT;
  if (!value) throw new Error("Missing phase result path.");
  return path.resolve(value);
}

function repositoryRoot(): string {
  const value = process.env.SITEINDEX_MEDIA_E2E_REPO_ROOT;
  if (!value) throw new Error("Missing repository root.");
  return path.resolve(value);
}

function phase(): "crash-worker" | "read-recovery" {
  const value = process.env.SITEINDEX_MEDIA_E2E_PHASE;
  if (value !== "crash-worker" && value !== "read-recovery") throw new Error("Invalid test phase.");
  return value;
}

function syntheticCredentialCanaries(): string[] {
  const seed = process.env.SITEINDEX_MEDIA_E2E_SEED;
  if (!seed || !/^[a-f0-9]{32}$/iu.test(seed)) throw new Error("Synthetic credential seed is invalid.");
  const username = `${FIXTURE_CREDENTIAL_USERNAME_PREFIX}${seed}`;
  const applicationPassword = `${FIXTURE_CREDENTIAL_PASSWORD_PREFIX}${seed}`;
  const authorization = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`;
  return [username, applicationPassword, authorization];
}

async function scanTreeForCanary(root: string, canaryValues: readonly string[]): Promise<number> {
  let matches = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await lstat(target);
        if (stat.size > 20 * 1024 * 1024) continue;
        const bytes = await readFile(target);
        for (const canary of canaryValues) {
          if (canary && bytes.includes(Buffer.from(canary))) matches += 1;
        }
      } catch {
        // Files may be transiently locked by Chromium; renderer storage is also checked through the live windows.
      }
    }
  };
  await visit(root);
  return matches;
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 25_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("Timed out waiting for synthetic Electron state.");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createFixtureProject(projectPath: string, baseUrl: string, imageUrl: string): Promise<void> {
  const fixture = path.join(repositoryRoot(), "fixtures", "expected", "project");
  await cp(fixture, projectPath, { recursive: true });

  const sitePath = path.join(projectPath, PATHS.site);
  const site = JSON.parse(await readFile(sitePath, "utf8")) as Record<string, any>;
  site.domain = "synthetic.example.test";
  site.base_url = baseUrl;
  site.brand = { name: "Synthetic", tagline: "Synthetic fixture", voice: "Synthetic", audience: "Synthetic", usp: [] };
  site.crawl.feed_url = [];
  site.crawl.rate_limit_ms = 0;
  site.edm = { ...site.edm, image_host: { type: "wordpress" } };
  await writeFile(sitePath, JSON.stringify(site, null, 2) + "\n", "utf8");

  const date = "2026-11-12";
  const skus = EXPECTED_SKUS.map((sku, index) => ({
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
    image_url: imageUrl,
    additional_images: [],
    gtin: null,
    mpn: null,
    brand: "Synthetic",
    status: "active",
    first_seen: date,
    last_seen: date,
    updated_at: date,
  }));
  const latest = skus.map(({ sku }) => ({
    sku,
    stock_status: "in_stock",
    qty: 4,
    since: date,
    checked_at: `${date}T12:00:00.000Z`,
  }));
  await writeFile(path.join(projectPath, PATHS.skus), skus.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(path.join(projectPath, PATHS.inventoryLatest), latest.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(path.join(projectPath, PATHS.skuMedia), "sku,image_role,image_url,alt_text,source,updated_at\n", "utf8");
  await writeFile(path.join(projectPath, PATHS.runs), "", "utf8");
}

async function startImageServer(): Promise<{ origin: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/webp", "content-length": WEBP_BYTES.length });
    response.end(WEBP_BYTES);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind the synthetic image service.");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function startWordPressServer(
  credentials: { username: string; applicationPassword: string },
): Promise<{ origin: string; secondUpload: Promise<void>; server: Server; canaryValues: string[] }> {
  const expectedAuthorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.applicationPassword}`).toString("base64")}`;
  let origin = "";
  let uploadCount = 0;
  const uploadedSlugs = new Map<number, string>();
  let signalSecondUpload!: () => void;
  let leaveSecondUploadPending!: () => void;
  const secondUpload = new Promise<void>((resolve) => {
    signalSecondUpload = resolve;
  });
  const neverRespondToSecondUpload = new Promise<void>((resolve) => {
    leaveSecondUploadPending = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "rest_not_logged_in", message: "Synthetic authentication rejected." }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/wp-json/wp/v2/users/me") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 1, name: "Synthetic Uploader", capabilities: { upload_files: true } }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/wp-json/wp/v2/media") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");
        return;
      }
      if (request.method === "POST" && url.pathname === "/wp-json/wp/v2/media") {
        for await (const _chunk of request) {
          // Read the synthetic multipart body without retaining or logging it.
        }
        uploadCount += 1;
        const contentDisposition = request.headers["content-disposition"];
        const disposition = Array.isArray(contentDisposition) ? contentDisposition[0] : contentDisposition;
        const filename = disposition?.match(/filename="([a-z0-9-]+)\.jpg"/iu)?.[1];
        if (!filename) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "synthetic_filename_missing" }));
          return;
        }
        if (uploadCount === 2) {
          signalSecondUpload();
          await neverRespondToSecondUpload;
          return;
        }
        uploadedSlugs.set(7001, filename);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 7001, slug: filename, source_url: `${origin}/wp-content/uploads/${filename}.jpg` }));
        return;
      }
      const metadataMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/u);
      if (request.method === "POST" && metadataMatch) {
        for await (const _chunk of request) {
          // Discard synthetic metadata.
        }
        const id = Number(metadataMatch[1]);
        const slug = uploadedSlugs.get(id) ?? "synthetic-metadata";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id, slug, source_url: `${origin}/wp-content/uploads/${slug}.jpg` }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    } catch {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_service_error" }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind the synthetic WordPress service.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    secondUpload,
    server,
    canaryValues: [credentials.username, credentials.applicationPassword, expectedAuthorization],
  };
}

function createWindowManagerForHarness() {
  const appPath = app.getAppPath();
  return createWindowManager({
    mainDirectory: path.join(appPath, "out", "main"),
    fallbackPath: path.join(appPath, "out", "renderer", "fallback.html"),
    devUiUrl: "http://127.0.0.1:5174",
    initiallyHidden: true,
    shouldHideOnClose: () => false,
    isShuttingDown: () => false,
    requestQuit: () => app.quit(),
  });
}

function registerProductionJobHandlers(
  manager: ReturnType<typeof createJobManager>,
  projects: Map<string, string>,
): string[] {
  const context = {
    jobs: manager,
    projects: {
      resolveProject(id: string) {
        const projectPath = projects.get(id);
        if (!projectPath) throw new Error("Synthetic project was not registered.");
        return projectPath;
      },
    },
    async withProject<T>(value: unknown, callback: (id: any) => Promise<T>): Promise<T> {
      if (typeof value !== "string" || !projects.has(value)) throw new Error("Synthetic project was not registered.");
      return callback(value as any);
    },
  } as any;
  const handlers = createHandlerRegistry({ ...createMediaHandlers(context), ...createJobsHandlers(context) });
  const registered: string[] = [];
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    });
    registered.push(channel);
  }
  return registered;
}

async function createRendererWindow(htmlPath: string, preloadPath: string, role: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadFile(htmlPath);
  await waitFor(() => window.webContents.executeJavaScript("window.__siteindexE2e?.ready === true"), Boolean);
  await window.webContents.executeJavaScript(`window.__siteindexE2e.role = ${JSON.stringify(role)}`);
  return window;
}

async function writeRendererFixture(root: string): Promise<string> {
  const filePath = path.join(root, "renderer.html");
  const html = `<!doctype html><meta charset="utf-8"><script>
    window.__siteindexE2e = { ready: false, role: "", progressCount: 0, finished: null, history: null };
    const compact = value => {
      if (!value || !Array.isArray(value.media_requested_skus) || !Array.isArray(value.media_results) || !Array.isArray(value.media_unknown_skus) || !Array.isArray(value.media_not_started_skus)) return { valid: false };
      const requested = value.media_requested_skus;
      const resultSkus = value.media_results.map(item => item.sku);
      const assigned = [...resultSkus, ...value.media_unknown_skus, ...value.media_not_started_skus];
      return {
        valid: assigned.length === requested.length && new Set(assigned).size === assigned.length && assigned.every(sku => requested.includes(sku)),
        runId: value.runId || value.run_id || "",
        requested: requested.length,
        confirmed: value.media_results.length,
        confirmedSkus: resultSkus,
        statuses: value.media_results.map(item => item.status),
        unknown: value.media_unknown_skus.length,
        notStarted: value.media_not_started_skus.length,
        batchState: value.media_batch_state || ""
      };
    };
    window.__siteindexE2e.compact = compact;
    window.siteindex.jobs.onProgress(() => { window.__siteindexE2e.progressCount += 1; });
    window.siteindex.jobs.onFinished(async result => {
      window.__siteindexE2e.finished = compact(result);
      if (window.__siteindexE2e.role === "observer") {
        try {
          const rows = await window.siteindex.jobs.history(${JSON.stringify("synthetic-media-recovery")});
          const row = rows.find(item => item.run_id === result.runId);
          window.__siteindexE2e.history = row ? compact(row) : { valid: false };
        } catch {
          window.__siteindexE2e.history = { valid: false };
        }
      }
    });
    window.__siteindexE2e.ready = true;
  </script>`;
  await writeFile(filePath, html, "utf8");
  return filePath;
}

function syntheticSettings(root: string) {
  return {
    device_id: "synthetic-device",
    device_name: "Synthetic Desktop",
    projects_root: root,
    extra_projects: [],
    cache_dir: path.join(root, "cache"),
    browser: { channel: "msedge", executable_path: null },
    notify: { on_failure: false, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [],
    conflict_patterns: [],
  } as const;
}

async function startMainProcessForPhase(phaseName: "crash-worker" | "read-recovery") {
  const root = rootPath();
  const userDataPath = path.join(root, `user-data-${phaseName}`);
  await mkdir(userDataPath, { recursive: true });
  app.setPath("userData", userDataPath);
  await app.whenReady();

  const primaryProjectPath = path.join(root, "projects", "synthetic-media-recovery");
  const secondaryProjectPath = path.join(root, "projects", "synthetic-media-isolation");
  const projects = new Map([
    [path.basename(primaryProjectPath), primaryProjectPath],
    [path.basename(secondaryProjectPath), secondaryProjectPath],
  ]);
  const credentialVault = createE2eCredentialVault();
  const getWordPressCredential = createWordPressMediaCredentialProvider({
    getProject: async (id) => {
      const projectPath = projects.get(id);
      if (!projectPath) throw new Error("Synthetic project was not registered.");
      const config = JSON.parse(await readFile(path.join(projectPath, PATHS.site), "utf8")) as {
        base_url: string;
        edm?: { image_host?: { type: string } };
      };
      return { config };
    },
    vault: credentialVault,
  });
  const windowManager = createWindowManagerForHarness();
  const workerOutput: string[] = [];
  let worker: ReturnType<typeof utilityProcess.fork> | null = null;
  const notifications: unknown[] = [];
  const settings = syntheticSettings(root);
  let resolveFinished!: (result: JobResult) => void;
  const finished = new Promise<JobResult>((resolve) => {
    resolveFinished = resolve;
  });
  const jobManager = createJobManager({
    workerPath: path.join(app.getAppPath(), "out", "main", "job-worker.js"),
    getSettings: async () => settings as any,
    isMediaJobReady: () => phaseName === "crash-worker",
    testOnlyAllowLoopbackHttp: phaseName === "crash-worker",
    getWordPressCredential,
    resolveProject: async (id) => projects.get(id) ?? primaryProjectPath,
    fork: (modulePath) => {
      worker = utilityProcess.fork(modulePath, [], { serviceName: "SiteIndex synthetic media recovery E2E" });
      worker.on("message", (message: unknown) => {
        try {
          workerOutput.push(JSON.stringify(message));
        } catch {
          workerOutput.push("[unserializable-worker-message]");
        }
      });
      return worker;
    },
    emitProgress: (progress) => windowManager.sendToWindows(ipcChannel("jobs.onProgress"), progress),
    emitFinished: (result) => {
      windowManager.sendToWindows(ipcChannel("jobs.onFinished"), result);
      resolveFinished(result);
    },
    notify: (_result, _settings, _rate) => notifications.push("notification"),
  });
  const registeredChannels = registerProductionJobHandlers(jobManager, projects);
  const htmlPath = await writeRendererFixture(root);
  const preloadPath = path.join(app.getAppPath(), "out", "preload", "index.cjs");
  const primaryWindow = await createRendererWindow(htmlPath, preloadPath, "primary");
  const observerWindow = await createRendererWindow(htmlPath, preloadPath, "observer");

  return {
    root,
    projects,
    primaryProjectPath,
    secondaryProjectPath,
    primaryWindow,
    observerWindow,
    windowManager,
    jobManager,
    credentialVault,
    getWordPressCredential,
    finished,
    worker: () => worker,
    workerOutput,
    notifications,
    registeredChannels,
    cleanup: async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
      await jobManager.shutdown();
      for (const channel of registeredChannels) ipcMain.removeHandler(channel);
    },
  };
}

async function crashWorkerPhase(): Promise<HarnessInternalResult> {
  const root = rootPath();
  const expectedPrimaryPath = path.join(root, "projects", "synthetic-media-recovery");
  const secondaryPath = path.join(root, "projects", "synthetic-media-isolation");
  await mkdir(path.dirname(expectedPrimaryPath), { recursive: true });
  const imageServer = await startImageServer();
  const canaryValues = syntheticCredentialCanaries();
  const credentials = { username: canaryValues[0]!, applicationPassword: canaryValues[1]! };
  const wordpress = await startWordPressServer(credentials);
  canaryValues.push(...wordpress.canaryValues);
  let system: Awaited<ReturnType<typeof startMainProcessForPhase>> | null = null;
  let phaseChecks: Record<string, boolean | number | string> = {};
  let phaseCode = "fixture-setup";
  const startedAt = Date.now();

  try {
    await createFixtureProject(expectedPrimaryPath, wordpress.origin, `${imageServer.origin}/synthetic.webp`);
    await createFixtureProject(secondaryPath, "https://isolated-other.example.test", `${imageServer.origin}/synthetic.webp`);
    phaseCode = "secondary-history-setup";
    const secondaryPaths = await pathsForProject(secondaryPath);
    await writeFile(path.join(secondaryPath, secondaryPaths.runs), `${JSON.stringify({
      run_id: "2026-11-11-media-legacy",
      job: "media",
      trigger: "manual",
      started_at: "2026-11-11T10:00:00.000Z",
      finished_at: "2026-11-11T10:01:00.000Z",
      status: "failed",
    })}\n`, "utf8");
    phaseCode = "desktop-window-and-handler-startup";
    const activeSystem = await startMainProcessForPhase("crash-worker");
    system = activeSystem;
    phaseCode = "save-credential-to-isolated-safe-storage-vault";
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("Isolated Local AppData is unavailable.");
    const vaultDirectory = resolveWordPressCredentialDirectory({
      platform: process.platform,
      localAppData,
      homeDirectory: app.getPath("home"),
    });
    const credentialVaultPathIsolated = isPathWithin(root, vaultDirectory) && isPathWithin(localAppData, vaultDirectory);
    if (!credentialVaultPathIsolated) throw new Error("Credential vault is outside the isolated test profile.");
    await activeSystem.credentialVault.save({ siteUrl: wordpress.origin, ...credentials });
    const credentialReadback = await activeSystem.credentialVault.getForHost(wordpress.origin);
    const credentialVaultSafeStorageRoundTrip =
      credentialReadback?.username === credentials.username &&
      credentialReadback.applicationPassword === credentials.applicationPassword;
    if (!credentialVaultSafeStorageRoundTrip) throw new Error("Electron safeStorage vault round-trip failed.");
    // The production handler path is exercised through the actual preload and ipcMain invoke bridge.
    phaseCode = "preload-media-ipc-start";
    const startRequest = await activeSystem.primaryWindow.webContents.executeJavaScript(
      `window.siteindex.media.prepare({project:${JSON.stringify(path.basename(expectedPrimaryPath))},skus:${JSON.stringify(EXPECTED_SKUS)}}).then(value=>{window.__siteindexE2e.expectedRunId=value.runId;return value})`,
    );
    if (!isPlainRecord(startRequest) || typeof startRequest.runId !== "string") throw new Error("Media IPC did not return a Core run ID.");
    const runId = startRequest.runId;
    const child = activeSystem.worker();
    if (!child || typeof child.pid !== "number") throw new Error("Electron utilityProcess was not created.");
    const utilityProcessPidObserved = typeof child.pid === "number";

    phaseCode = "wait-for-second-external-request";
    const wpReachedSecondUpload = await Promise.race([
      wordpress.secondUpload.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 45_000)),
    ]);
    if (!wpReachedSecondUpload) throw new Error("Synthetic second media request was not reached.");

    phaseCode = "validate-durable-checkpoint";
    const projectPaths = await pathsForProject(expectedPrimaryPath);
    const checkpointPath = path.join(expectedPrimaryPath, projectPaths.jobLogsDir, `${runId}.media.json`);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, any>;
    const coreRunIdPreserved = checkpoint.run_id === runId;
    const checkpointValid =
      coreRunIdPreserved &&
      checkpoint.checkpoint_state === "running" &&
      isValidMediaSkuRecoveryPartition(checkpoint) &&
      JSON.stringify(checkpoint.media_requested_skus) === JSON.stringify(EXPECTED_SKUS) &&
      checkpoint.media_results.length === 1 && checkpoint.media_results[0]?.status === "uploaded" &&
      JSON.stringify(checkpoint.media_results.map(({ sku }: { sku: string }) => sku)) === JSON.stringify([EXPECTED_SKUS[0]]) &&
      JSON.stringify(checkpoint.media_unknown_skus) === JSON.stringify([EXPECTED_SKUS[1]]) &&
      JSON.stringify(checkpoint.media_not_started_skus) === JSON.stringify([EXPECTED_SKUS[2]]);
    if (!checkpointValid) throw new Error("Media checkpoint was not the expected durable partition before worker termination.");
    let projectLockHeldBeforeKill = false;
    try {
      const lock = JSON.parse(await readFile(path.join(expectedPrimaryPath, projectPaths.lock), "utf8")) as Record<string, unknown>;
      projectLockHeldBeforeKill =
        lock.pid === child.pid &&
        lock.job === "media" &&
        lock.device_id === "synthetic-device";
    } catch {
      // The acceptance check below fails without disclosing any lock contents.
    }
    let workerExited = false;
    child.once("exit", () => { workerExited = true; });
    phaseCode = "hard-kill-and-recover-manager-state";
    child.kill();

    const result = await Promise.race([
      activeSystem.finished,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Desktop did not finish after worker crash.")), 30_000)),
    ]);
    const checkpointReadAfterWorkerExit = workerExited;
    const managerResultValid = result.runId === runId && isValidMediaSkuRecoveryPartition(result);
    if (!managerResultValid) throw new Error("Recovered result did not preserve the checkpoint partition.");

    phaseCode = "wait-main-window-finished-event";
    const primaryState = await waitFor(
      () => activeSystem.primaryWindow.webContents.executeJavaScript("window.__siteindexE2e.finished"),
      isPlainRecord,
    );
    phaseCode = "wait-second-window-preload-history";
    const observerState = await waitFor(
      () => activeSystem.observerWindow.webContents.executeJavaScript("window.__siteindexE2e.history"),
      (value) => isPlainRecord(value) && value.valid === true,
    );
    const runLogText = await readFile(path.join(expectedPrimaryPath, projectPaths.runs), "utf8");
    const row = (await activeSystem.jobManager.history(path.basename(expectedPrimaryPath) as any)).find((item) => item.run_id === runId);
    let leakedLock = false;
    try {
      await lstat(path.join(expectedPrimaryPath, projectPaths.lock));
      leakedLock = true;
    } catch {
      // The worker lock must be gone once JobManager has finalized recovery.
    }
    const rendererStates = await Promise.all(
      [activeSystem.primaryWindow, activeSystem.observerWindow].map((window) =>
        window.webContents.executeJavaScript(`JSON.stringify({state:window.__siteindexE2e,localStorage:Object.entries(localStorage),sessionStorage:Object.entries(sessionStorage),body:document.body.innerText})`),
      ),
    );
    const canaryMaterial = JSON.stringify({
      result,
      checkpoint,
      row,
      runLogText,
      rendererStates,
      workerOutput: activeSystem.workerOutput,
      notifications: activeSystem.notifications,
    });
    phaseCode = "verify-credential-storage";
    const canaryMatches =
      canaryValues.reduce((count, value) => count + (canaryMaterial.includes(value) ? 1 : 0), 0) +
      await scanTreeForCanary(root, canaryValues);
    const observerHistoryMatches =
      isPlainRecord(observerState) &&
      observerState.runId === runId &&
      observerState.confirmed === 1 &&
      JSON.stringify(observerState.confirmedSkus) === JSON.stringify([EXPECTED_SKUS[0]]) &&
      JSON.stringify(observerState.statuses) === JSON.stringify(["uploaded"]) &&
      observerState.unknown === 1 &&
      observerState.notStarted === 1;
    const rendererFinishMatches =
      isPlainRecord(primaryState) &&
      primaryState.runId === runId &&
      primaryState.confirmed === 1 &&
      JSON.stringify(primaryState.confirmedSkus) === JSON.stringify([EXPECTED_SKUS[0]]) &&
      JSON.stringify(primaryState.statuses) === JSON.stringify(["uploaded"]) &&
      primaryState.unknown === 1 &&
      primaryState.notStarted === 1;
    const durableRunLogMatches =
      !!row &&
      row.run_id === runId &&
      isValidMediaSkuRecoveryPartition(row) &&
      row.media_results.length === 1 && row.media_results[0]?.sku === EXPECTED_SKUS[0] && row.media_results[0]?.status === "uploaded" &&
      row.media_unknown_skus.length === 1 && row.media_unknown_skus[0] === EXPECTED_SKUS[1] &&
      row.media_not_started_skus.length === 1 && row.media_not_started_skus[0] === EXPECTED_SKUS[2];
    phaseChecks = {
      utilityProcessPidObserved,
      projectLockHeldByUtilityProcessBeforeKill: projectLockHeldBeforeKill,
      checkpointAtomicPartitionBeforeKill: checkpointValid,
      checkpointRunIdMatchesStartedCoreRun: coreRunIdPreserved,
      workerKilledWithoutCancelRequest: true,
      checkpointReadAfterWorkerExit,
      projectLockReleasedAfterRecovery: !leakedLock,
      managerRecoveredRunId: result.runId === runId,
      mainRendererReceivedRecoveryEvent: rendererFinishMatches,
      observerRendererReadRecoveredHistory: observerHistoryMatches,
      runLogMatchesRecoveredPartition: durableRunLogMatches,
      credentialCanaryMatches: canaryMatches,
      credentialVaultPathIsolated,
      credentialVaultSafeStorageRoundTrip,
      credentialUsedForSyntheticWordPressAuth: result.media_results.some(({ status }) => status === "uploaded"),
      durationMs: Date.now() - startedAt,
    };
    if (
      canaryMatches !== 0 ||
      !rendererFinishMatches ||
      !observerHistoryMatches ||
      !durableRunLogMatches ||
      !credentialVaultPathIsolated ||
      !credentialVaultSafeStorageRoundTrip ||
      !checkpointReadAfterWorkerExit ||
      !projectLockHeldBeforeKill ||
      leakedLock ||
      !coreRunIdPreserved
    ) throw new Error("Crash phase acceptance assertion failed.");
    const internal: HarnessInternalResult = { status: "passed", phase: "crash-worker", runId, checks: phaseChecks };
    await Promise.all([
      writeFile(path.join(root, "media-e2e-internal.json"), JSON.stringify(internal), "utf8"),
      writeFile(reportPath(), JSON.stringify(internal), "utf8"),
    ]);
    return internal;
  } catch (error) {
    const internal: HarnessInternalResult = {
      status: "failed",
      phase: "crash-worker",
      failureCode: phaseCode,
      ...(phaseChecks ? { checks: phaseChecks } : {}),
    };
    await writeFile(path.join(root, "media-e2e-internal.json"), JSON.stringify(internal), "utf8");
    throw error;
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => { imageServer.server.close(() => resolve()); imageServer.server.closeAllConnections?.(); }),
      new Promise<void>((resolve) => { wordpress.server.close(() => resolve()); wordpress.server.closeAllConnections?.(); }),
    ]);
    await system?.cleanup();
  }
}

async function readRecoveryPhase(): Promise<HarnessInternalResult> {
  const root = rootPath();
  const internalPath = path.join(root, "media-e2e-internal.json");
  const crashResult = JSON.parse(await readFile(internalPath, "utf8")) as HarnessInternalResult;
  if (crashResult.status !== "passed" || !crashResult.runId) throw new Error("Crash recovery phase did not complete.");
  const expectedRunId = crashResult.runId;
  const system = await startMainProcessForPhase("read-recovery");
  const startedAt = Date.now();
  let phaseCode = "restart-history-queries";
  try {
    const projectId = path.basename(system.primaryProjectPath);
    const otherProjectId = path.basename(system.secondaryProjectPath);
    phaseCode = "read-encrypted-credential-after-process-restart";
    const persistedCredential = await system.getWordPressCredential(projectId as ProjectId);
    const expectedCredential = syntheticCredentialCanaries();
    const credentialVaultRecoveredAfterProcessRestart =
      persistedCredential.username === expectedCredential[0] &&
      persistedCredential.applicationPassword === expectedCredential[1];
    let credentialNotSharedAcrossDifferentProjectOrigin = false;
    try {
      await system.getWordPressCredential(otherProjectId as ProjectId);
    } catch (error) {
      credentialNotSharedAcrossDifferentProjectOrigin =
        typeof error === "object" && error !== null && "code" in error && error.code === "WP_NOT_CONFIGURED";
    }
    const [primaryRows, isolatedRows] = await Promise.all([
      system.observerWindow.webContents.executeJavaScript(`window.siteindex.jobs.history(${JSON.stringify(projectId)})`),
      system.observerWindow.webContents.executeJavaScript(`window.siteindex.jobs.history(${JSON.stringify(otherProjectId)})`),
    ]);
    const recovered = Array.isArray(primaryRows) ? primaryRows.find((row) => row.run_id === expectedRunId) : undefined;
    const oldRecord = Array.isArray(isolatedRows) ? isolatedRows.find((row) => row.run_id === "2026-11-11-media-legacy") : undefined;
    const report = {
      runIdReadAfterMainRestart: recovered?.run_id === expectedRunId,
      recoveredPartitionValid: isValidMediaSkuRecoveryPartition(recovered),
      recoveredRequestedOrderMatches: JSON.stringify(recovered?.media_requested_skus) === JSON.stringify(EXPECTED_SKUS),
      recoveredConfirmedCount: Array.isArray(recovered?.media_results) ? recovered.media_results.length : 0,
      recoveredConfirmedSkuIsUploaded:
        Array.isArray(recovered?.media_results) &&
        recovered.media_results[0]?.sku === EXPECTED_SKUS[0] &&
        recovered.media_results[0]?.status === "uploaded",
      recoveredUnknownCount: Array.isArray(recovered?.media_unknown_skus) ? recovered.media_unknown_skus.length : 0,
      recoveredUnknownSkuMatches: JSON.stringify(recovered?.media_unknown_skus) === JSON.stringify([EXPECTED_SKUS[1]]),
      recoveredNotStartedCount: Array.isArray(recovered?.media_not_started_skus) ? recovered.media_not_started_skus.length : 0,
      recoveredNotStartedSkuMatches: JSON.stringify(recovered?.media_not_started_skus) === JSON.stringify([EXPECTED_SKUS[2]]),
      oldRecordDoesNotInventRecoveryFields:
        !!oldRecord &&
        !Object.hasOwn(oldRecord, "media_requested_skus") &&
        !Object.hasOwn(oldRecord, "media_results") &&
        !Object.hasOwn(oldRecord, "media_unknown_skus") &&
        !Object.hasOwn(oldRecord, "media_not_started_skus"),
      noCrossProjectRunLeak:
        Array.isArray(isolatedRows) && isolatedRows.every((row) => row.run_id !== expectedRunId),
      credentialVaultRecoveredAfterProcessRestart,
      credentialNotSharedAcrossDifferentProjectOrigin,
      observerWindowCount: BrowserWindow.getAllWindows().length,
      noCredentialCanaryInRendererOrHistory: true,
      durationMs: Date.now() - startedAt,
    };
    const windows = BrowserWindow.getAllWindows();
    const localState = await Promise.all(windows.map((window) =>
      window.webContents.executeJavaScript(`JSON.stringify({state:window.__siteindexE2e,localStorage:Object.entries(localStorage),sessionStorage:Object.entries(sessionStorage),body:document.body.innerText})`),
    ));
    const serialized = JSON.stringify({ primaryRows, isolatedRows, localState });
    phaseCode = "verify-credential-storage-after-restart";
    const canaries = syntheticCredentialCanaries();
    const canaryMatches =
      canaries.reduce((count, value) => count + (serialized.includes(value) ? 1 : 0), 0) +
      await scanTreeForCanary(root, canaries);
    report.noCredentialCanaryInRendererOrHistory = canaryMatches === 0;
    const passed =
      report.runIdReadAfterMainRestart &&
      report.recoveredPartitionValid &&
      report.recoveredRequestedOrderMatches &&
      report.recoveredConfirmedCount === 1 &&
      report.recoveredConfirmedSkuIsUploaded &&
      report.recoveredUnknownCount === 1 &&
      report.recoveredUnknownSkuMatches &&
      report.recoveredNotStartedCount === 1 &&
      report.recoveredNotStartedSkuMatches &&
      report.oldRecordDoesNotInventRecoveryFields &&
      report.noCrossProjectRunLeak &&
      credentialVaultRecoveredAfterProcessRestart &&
      credentialNotSharedAcrossDifferentProjectOrigin &&
      report.observerWindowCount === 2 &&
      report.noCredentialCanaryInRendererOrHistory;
    if (!passed) throw new Error("Restart read acceptance assertion failed.");
    return { status: "passed", phase: "read-recovery", runId: expectedRunId, checks: report };
  } catch {
    const failure: HarnessInternalResult = { status: "failed", phase: "read-recovery", failureCode: phaseCode };
    await writeFile(reportPath(), JSON.stringify(failure), "utf8").catch(() => undefined);
    throw new Error(`Restart phase failed at ${phaseCode}.`);
  } finally {
    await system.cleanup();
  }
}

async function main(): Promise<void> {
  app.disableHardwareAcceleration();
  let phaseName: "crash-worker" | "read-recovery" = "crash-worker";
  try {
    phaseName = phase();
    const result = phaseName === "crash-worker" ? await crashWorkerPhase() : await readRecoveryPhase();
    await writeFile(reportPath(), JSON.stringify(result), "utf8");
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    app.quit();
  } catch (error) {
    let failureCode = error instanceof Error ? error.name : "unknown";
    try {
      const priorReport = JSON.parse(await readFile(reportPath(), "utf8")) as HarnessInternalResult;
      if (priorReport.status === "failed" && priorReport.phase === phaseName && priorReport.failureCode) {
        failureCode = priorReport.failureCode;
      }
    } catch {
      // Fall back to the exception class without including any error detail.
    }
    if (phaseName === "crash-worker" && failureCode === "Error") {
      try {
        const internal = JSON.parse(await readFile(path.join(rootPath(), "media-e2e-internal.json"), "utf8")) as HarnessInternalResult;
        if (internal.phase === phaseName && internal.failureCode) failureCode = internal.failureCode;
      } catch {
        // Fall back to the exception class without including any error detail.
      }
    }
    const result: HarnessInternalResult = {
      status: "failed",
      phase: phaseName,
      failureCode,
    };
    await writeFile(reportPath(), JSON.stringify(result), "utf8").catch(() => undefined);
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
}

void main();
