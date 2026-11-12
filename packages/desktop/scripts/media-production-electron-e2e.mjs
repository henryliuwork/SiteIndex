import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanMediaCanaryTree } from "./media-production-canary-scan.mjs";
import { mediaTrafficChecks } from "./media-production-traffic.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const packagedApp = path.join(repositoryRoot, "release-media-production-e2e", "win-unpacked", "SiteIndex.exe");
const summaryPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const phases = [
  "success",
  "auth-401",
  "forbidden-403",
  "post-lost",
  "retry",
  "post-429",
  "retry-429",
  "post-503",
  "retry-503",
];
const seed = randomBytes(16).toString("hex");
const credentials = { username: `fixture-user-${seed}`, password: `fixture-secret-${seed}` };
const credentialPair = `${credentials.username}:${credentials.password}`;
const canaryStrings = [
  credentials.username,
  credentials.password,
  credentialPair,
  Buffer.from(credentials.username).toString("base64"),
  Buffer.from(credentials.password).toString("base64"),
  Buffer.from(credentialPair).toString("base64"),
  `Basic ${Buffer.from(credentialPair).toString("base64")}`,
];
const canaryBytes = [
  ...canaryStrings.map((value) => Buffer.from(value, "utf8")),
  ...canaryStrings.map((value) => Buffer.from(value, "utf16le")),
];

function assertSafeTempRoot(root) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  if (
    !path.basename(resolved).startsWith("siteindex-media-production-e2e-") ||
    !resolved.startsWith(`${tempRoot}${path.sep}`)
  ) {
    throw new Error("Temporary test root failed its deletion guard.");
  }
}

async function readAndDiscard(request) {
  for await (const _chunk of request) {
    // The fake server intentionally discards upload bytes without persisting or logging them.
  }
}

async function startImageServer() {
  const webp = Buffer.from("UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEB8w/wKCIv9HCwFB0XXLBXwU1LRtwOI36YjofxwA", "base64");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const metrics = { requests: 0, missing: 0 };
  const server = createServer((request, response) => {
    metrics.requests += 1;
    if (request.url === "/missing.webp") {
      metrics.missing += 1;
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Synthetic source missing.");
      return;
    }
    if (request.url === "/record.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      response.end(png);
      return;
    }
    if (request.url?.endsWith(".webp")) {
      response.writeHead(200, { "content-type": "image/webp", "content-length": webp.length });
      response.end(webp);
      return;
    }
    metrics.missing += 1;
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Synthetic source missing.");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("image-server-bind-failed");
  return { origin: `http://127.0.0.1:${address.port}`, server, metrics };
}

async function startWordPressServer(testRoot) {
  const metrics = {
    lookups: 0,
    slugLookups: 0,
    createPosts: 0,
    createResponses201: 0,
    metadataPosts: 0,
    unauthorized: 0,
    forbidden: 0,
    persistedBeforeDisconnect: 0,
    persistedBeforeHttpFailure: 0,
    http429: 0,
    http503: 0,
    retryAfterOneSecondHeadersSent: 0,
  };
  const uploaded = new Map();
  let nextId = 100;
  let dropNextUploadResponse = false;
  let uploadFailure = null;
  let uploadPostOrdinal = 0;
  let uiReturnedBeforeResponseLoss = false;
  let origin = "";
  const validAuthorization = `Basic ${Buffer.from(credentialPair).toString("base64")}`;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      const authorization = request.headers.authorization;
      const isAuthorized = authorization === validAuthorization;
      if (!isAuthorized) {
        metrics.unauthorized += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "rest_not_logged_in", message: "Synthetic authentication rejected." }));
        if (request.method !== "GET") await readAndDiscard(request);
        return;
      }
      if (request.method === "GET" && url.pathname === "/wp-json/wp/v2/media") {
        metrics.lookups += 1;
        const slug = url.searchParams.get("slug");
        if (slug !== null) metrics.slugLookups += 1;
        const match = slug ? uploaded.get(slug) : undefined;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(match ? [match] : []));
        return;
      }
      if (request.method === "POST" && url.pathname === "/wp-json/wp/v2/media") {
        await readAndDiscard(request);
        metrics.createPosts += 1;
        uploadPostOrdinal += 1;
        const disposition = request.headers["content-disposition"];
        const slug = (Array.isArray(disposition) ? disposition[0] : disposition)?.match(
          /filename="([a-z0-9-]+)\.jpg"/iu,
        )?.[1];
        if (!slug) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "synthetic_filename_missing" }));
          return;
        }
        const injectedFailure = uploadFailure?.ordinal === uploadPostOrdinal ? uploadFailure : null;
        if (injectedFailure) uploadFailure = null;
        if (injectedFailure?.persist) {
          const id = nextId++;
          const item = { id, slug, source_url: `${origin}/wp-content/uploads/${slug}.jpg` };
          uploaded.set(slug, item);
          metrics.persistedBeforeHttpFailure += 1;
        }
        if (injectedFailure) {
          if (injectedFailure.status === 401) metrics.unauthorized += 1;
          if (injectedFailure.status === 403) metrics.forbidden += 1;
          if (injectedFailure.status === 429) metrics.http429 += 1;
          if (injectedFailure.status === 503) metrics.http503 += 1;
          const headers = { "content-type": "application/json" };
          if (injectedFailure.status === 429) {
            headers["retry-after"] = "1";
            metrics.retryAfterOneSecondHeadersSent += 1;
          }
          response.writeHead(injectedFailure.status, headers);
          response.end(
            JSON.stringify({
              code:
                injectedFailure.status === 401
                  ? "rest_not_logged_in"
                  : injectedFailure.status === 403
                    ? "rest_cannot_create"
                    : "synthetic_service_error",
              message: "Synthetic upload response failure.",
            }),
          );
          return;
        }
        const id = nextId++;
        const item = { id, slug, source_url: `${origin}/wp-content/uploads/${slug}.jpg` };
        uploaded.set(slug, item);
        if (dropNextUploadResponse) {
          dropNextUploadResponse = false;
          metrics.persistedBeforeDisconnect += 1;
          const signalPath = path.join(testRoot, "post-lost-ui-returned");
          const signalDeadline = Date.now() + 30_000;
          while (Date.now() < signalDeadline) {
            try {
              await readFile(signalPath, "utf8");
              uiReturnedBeforeResponseLoss = true;
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          response.destroy();
          return;
        }
        metrics.createResponses201 += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify(item));
        return;
      }
      const metadata = url.pathname.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/u);
      if (request.method === "POST" && metadata) {
        await readAndDiscard(request);
        metrics.metadataPosts += 1;
        const item = [...uploaded.values()].find((value) => value.id === Number(metadata[1]));
        response.writeHead(item ? 200 : 404, { "content-type": "application/json" });
        response.end(JSON.stringify(item ?? { error: "synthetic_media_missing" }));
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("wordpress-server-bind-failed");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    server,
    metrics,
    get uploadedCount() {
      return uploaded.size;
    },
    get uiReturnedBeforeResponseLoss() {
      return uiReturnedBeforeResponseLoss;
    },
    failUploadOnOrdinal(ordinal, status, persist) {
      if (!Number.isInteger(ordinal) || ordinal < 1 || ![401, 403, 429, 503].includes(status)) {
        throw new Error("invalid-synthetic-upload-failure");
      }
      uploadFailure = { ordinal, status, persist };
      uploadPostOrdinal = 0;
    },
    dropNextUploadResponse() {
      dropNextUploadResponse = true;
    },
  };
}

function inheritedEnvironment() {
  const allowed = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}

async function runPackagedPhase(root, phase, imageOrigin, wordpressOrigin) {
  const reportPath = path.join(root, `phase-${phase}.json`);
  await writeFile(reportPath, JSON.stringify({ status: "running", phase }), "utf8");
  const isolatedLocalAppData = path.join(root, "local-app-data");
  const isolatedRoamingAppData = path.join(root, "roaming-app-data");
  const env = {
    ...inheritedEnvironment(),
    LOCALAPPDATA: isolatedLocalAppData,
    APPDATA: isolatedRoamingAppData,
    SITEINDEX_MEDIA_E2E_PHASE: phase,
    SITEINDEX_MEDIA_E2E_PHASE_RESULT: reportPath,
    SITEINDEX_MEDIA_E2E_ROOT: root,
    SITEINDEX_MEDIA_E2E_REPO_ROOT: repositoryRoot,
    SITEINDEX_MEDIA_E2E_SEED: seed,
    SITEINDEX_MEDIA_E2E_IMAGE_ORIGIN: imageOrigin,
    SITEINDEX_MEDIA_E2E_WP_ORIGIN: wordpressOrigin,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(packagedApp, [], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => child.kill(), 180_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Packaged phase ${phase} could not start.`));
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      const captured = Buffer.concat(output);
      const capturedCanaryMatches = canaryBytes.filter((value) => captured.includes(value)).length;
      if (capturedCanaryMatches > 0) {
        reject(new Error(`Packaged phase ${phase} leaked a credential canary in process output.`));
        return;
      }
      try {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        if (code !== 0 || report.status !== "passed" || report.phase !== phase) {
          reject(
            new Error(
              `Packaged phase ${phase} failed (exit ${code ?? "unknown"}; code ${report.failureCode ?? "invalid-report"}; output lines ${captured.toString("utf8").split(/\r?\n/u).filter(Boolean).length}).`,
            ),
          );
          return;
        }
        resolve(report);
      } catch {
        reject(new Error(`Packaged phase ${phase} produced no valid result report.`));
      }
    });
  });
}

async function main() {
  if (!summaryPath) throw new Error("A summary output path is required.");
  const mainSource = await readFile(
    path.join(repositoryRoot, "packages", "desktop", "src", "main", "index.ts"),
    "utf8",
  );
  const readinessSource = await readFile(
    path.join(repositoryRoot, "packages", "desktop", "src", "main", "media-readiness.ts"),
    "utf8",
  );
  if (
    !/isMediaJobReady:\s*\(\)\s*=>\s*isMediaPrepareReady\(mediaCore\)/u.test(mainSource) ||
    !/core\s*!==\s*null\s*&&\s*!pendingHandlers\.includes\("media\.prepare"\)/u.test(readinessSource)
  ) {
    throw new Error("Production media readiness is not guarded by the initialized Core and shared contract status.");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-media-production-e2e-"));
  assertSafeTempRoot(root);
  const image = await startImageServer();
  const wordpress = await startWordPressServer(root);
  const phaseResults = {};
  const traffic = [];
  let postLostPackagedAppExited = false;
  let summaryWritten = false;
  try {
    if (!process.platform.startsWith("win")) throw new Error("packaged-acceptance-requires-windows");
    await access(packagedApp).catch(() => {
      throw new Error("packaged-app-missing");
    });
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await mkdir(path.join(root, "local-app-data"), { recursive: true });
    await mkdir(path.join(root, "roaming-app-data"), { recursive: true });
    for (const phase of phases) {
      if (phase === "post-lost") wordpress.dropNextUploadResponse();
      if (phase === "auth-401") wordpress.failUploadOnOrdinal(2, 401, false);
      if (phase === "forbidden-403") wordpress.failUploadOnOrdinal(2, 403, false);
      if (phase === "post-429") wordpress.failUploadOnOrdinal(1, 429, true);
      if (phase === "post-503") wordpress.failUploadOnOrdinal(1, 503, true);
      const before = {
        ...wordpress.metrics,
        imageRequests: image.metrics.requests,
        uploadedCount: wordpress.uploadedCount,
      };
      phaseResults[phase] = await runPackagedPhase(root, phase, image.origin, wordpress.origin);
      if (phase === "post-lost") postLostPackagedAppExited = true;
      const recoveryPhase =
        phase === "retry"
          ? "post-lost"
          : phase === "retry-429"
            ? "post-429"
            : phase === "retry-503"
              ? "post-503"
              : null;
      if (recoveryPhase) {
        phaseResults[phase].checks = {
          ...phaseResults[phase].checks,
          packagedAppExitedAfterUnknownPost:
            recoveryPhase === "post-lost" ? postLostPackagedAppExited : Object.hasOwn(phaseResults, recoveryPhase),
        };
      }
      const after = {
        ...wordpress.metrics,
        imageRequests: image.metrics.requests,
        uploadedCount: wordpress.uploadedCount,
      };
      traffic.push({
        phase,
        mediaLookups: after.lookups - before.lookups,
        mediaSlugLookups: after.slugLookups - before.slugLookups,
        mediaCreatePosts: after.createPosts - before.createPosts,
        mediaCreateResponses201: after.createResponses201 - before.createResponses201,
        metadataPosts: after.metadataPosts - before.metadataPosts,
        auth401: after.unauthorized - before.unauthorized,
        auth403: after.forbidden - before.forbidden,
        http429: after.http429 - before.http429,
        http503: after.http503 - before.http503,
        retryAfterOneSecondHeadersSent: after.retryAfterOneSecondHeadersSent - before.retryAfterOneSecondHeadersSent,
        imageRequests: after.imageRequests - before.imageRequests,
        uploadedObjects: after.uploadedCount - before.uploadedCount,
        responseLostAfterCommit: after.persistedBeforeDisconnect - before.persistedBeforeDisconnect,
        persistedBeforeHttpFailure: after.persistedBeforeHttpFailure - before.persistedBeforeHttpFailure,
      });
    }
    for (const entry of traffic) {
      entry.checks = mediaTrafficChecks(entry.phase, entry);
    }
    const cases = {
      allHttpTrafficMatchesExplicitPhaseBaselines: traffic.every(
        (entry) => entry.checks.matchesExpectedTraffic === true,
      ),
      successUsesActualUiAndIpc: phaseResults.success.checks?.actualEdmUiInvokedMediaPrepare === true,
      successIncludesUploadedRecordedSkippedAndPerSkuFailures:
        phaseResults.success.checks?.resultCounts ===
        JSON.stringify({
          uploaded: 2,
          recorded: 1,
          skipped_has_url: 1,
          failed: 2,
          unknown: 0,
          not_started: 0,
          reused: 0,
        }),
      auth401AfterFirstSuccessStopsThirdSku:
        phaseResults["auth-401"].checks?.expectedAuthorizationCode === "WP_AUTH_FAILED" &&
        traffic.find((entry) => entry.phase === "auth-401")?.auth401 === 1 &&
        phaseResults["auth-401"].checks?.resultCounts ===
          JSON.stringify({
            uploaded: 1,
            recorded: 0,
            skipped_has_url: 0,
            failed: 1,
            unknown: 0,
            not_started: 1,
            reused: 0,
          }),
      forbidden403AfterFirstSuccessStopsThirdSku:
        phaseResults["forbidden-403"].checks?.expectedAuthorizationCode === "WP_FORBIDDEN" &&
        traffic.find((entry) => entry.phase === "forbidden-403")?.auth403 === 1 &&
        phaseResults["forbidden-403"].checks?.resultCounts ===
          JSON.stringify({
            uploaded: 1,
            recorded: 0,
            skipped_has_url: 0,
            failed: 1,
            unknown: 0,
            not_started: 1,
            reused: 0,
          }),
      postPersistedBeforeResponseLoss:
        traffic.find((entry) => entry.phase === "post-lost")?.responseLostAfterCommit === 1,
      retryReusesWithoutSecondMediaCreate:
        phaseResults.retry.checks?.retryOrOutcomeUnknownMatches === true &&
        traffic.find((entry) => entry.phase === "retry")?.checks?.retryUsesSlugLookupWithoutCreate === true,
      post429PersistedBeforeUnknownAndRetryReused:
        phaseResults["post-429"].checks?.retryOrOutcomeUnknownMatches === true &&
        traffic.find((entry) => entry.phase === "post-429")?.checks?.matchesExpectedTraffic === true &&
        traffic.find((entry) => entry.phase === "post-429")?.persistedBeforeHttpFailure === 1 &&
        traffic.find((entry) => entry.phase === "retry-429")?.checks?.retryUsesSlugLookupWithoutCreate === true &&
        phaseResults["retry-429"].checks?.restartUnknownOutcomeRecoveredOnColdMount === true &&
        phaseResults["retry-429"].checks?.retryReviewDialogConfirmed === true,
      retryAfter429IsSingleResponseWithoutAutomaticResend:
        traffic.find((entry) => entry.phase === "post-429")?.checks?.matchesExpectedTraffic === true &&
        traffic.find((entry) => entry.phase === "post-429")?.checks?.retryAfterOneSecondHeaderSentOnce === true,
      post503PersistedBeforeUnknownAndRetryReused:
        phaseResults["post-503"].checks?.retryOrOutcomeUnknownMatches === true &&
        traffic.find((entry) => entry.phase === "post-503")?.checks?.matchesExpectedTraffic === true &&
        traffic.find((entry) => entry.phase === "post-503")?.persistedBeforeHttpFailure === 1 &&
        traffic.find((entry) => entry.phase === "retry-503")?.checks?.retryUsesSlugLookupWithoutCreate === true &&
        phaseResults["retry-503"].checks?.restartUnknownOutcomeRecoveredOnColdMount === true &&
        phaseResults["retry-503"].checks?.retryReviewDialogConfirmed === true,
      rendererReceivedUtilityProcessProgress: phaseResults.success.checks?.progressEvidenceComplete === true,
      navigatedAwayWhileJobRunningAndItCompletedInBackground:
        phaseResults["post-lost"].checks?.crossPageDuringActiveJob === true &&
        phaseResults["post-lost"].checks?.jobCompletedAwayFromEdm === true &&
        wordpress.uiReturnedBeforeResponseLoss,
      rendererCrossPageRecovery: phaseResults["post-lost"].checks?.crossPageRecoveryAfterJob === true,
      appRestartRecoveredUnknownAndConfirmedRetry:
        phaseResults.retry.checks?.packagedAppExitedAfterUnknownPost === true &&
        phaseResults.retry.checks?.restartUnknownOutcomeRecoveredOnColdMount === true &&
        phaseResults.retry.checks?.retryReviewDialogConfirmed === true &&
        phaseResults.retry.checks?.retryOrOutcomeUnknownMatches === true &&
        traffic.find((entry) => entry.phase === "retry")?.mediaCreatePosts === 0,
    };
    for (const phase of ["retry-429", "retry-503"]) {
      cases[`${phase}AppRestartedUnknownAndConfirmedRetry`] =
        phaseResults[phase].checks?.packagedAppExitedAfterUnknownPost === true &&
        phaseResults[phase].checks?.restartUnknownOutcomeRecoveredOnColdMount === true &&
        phaseResults[phase].checks?.retryReviewDialogConfirmed === true &&
        phaseResults[phase].checks?.retryOrOutcomeUnknownMatches === true &&
        traffic.find((entry) => entry.phase === phase)?.checks?.retryUsesSlugLookupWithoutCreate === true;
    }
    const canaryScan = await scanMediaCanaryTree(root, canaryBytes);
    const summary = {
      schemaVersion: 1,
      sourceCommit: process.env.SITEINDEX_MEDIA_E2E_SOURCE_COMMIT ?? "local",
      runner: "windows-latest",
      packagedElectron: true,
      packageKind: "electron-builder-win-unpacked-directory-not-nsis-installer",
      actualBuiltEdmUiAndPreload: true,
      productionMediaGateOpenBySharedContract: true,
      testOnlyUiGateBypass: false,
      productionUiBundleCopiedUnmodified: true,
      packagedAcceptanceBootstrap: "isolated-main-entry-using-production-ipc-job-manager-worker-and-core",
      testOnlyLoopbackHttp: true,
      wordpressProductionHttpsPolicyVerified: false,
      retryAfterCoverage: {
        synthetic429Header: "Retry-After: 1 is sent once and counted",
        automaticUploadRetry: "not performed; Core returns outcome_unknown after the first non-auth POST error",
        retryAfterBackoff: "not covered because this path does not automatically retry",
        userConfirmedRecovery:
          "after restart, at least one slug lookup is required and a second create POST is forbidden",
      },
      credentialEncodingClassesChecked: 5,
      cases,
      phases: Object.fromEntries(Object.entries(phaseResults).map(([phase, result]) => [phase, result.checks ?? {}])),
      traffic,
      localFileCountScanned: canaryScan.filesScanned,
      criticalFileCounts: canaryScan.criticalFilesRead,
      missingCriticalFileKindCount: canaryScan.missingCriticalKinds.length,
      criticalReadErrors: canaryScan.criticalReadErrors,
      otherReadErrors: canaryScan.otherReadErrors,
      chromiumCachePathsSkipped: canaryScan.chromiumCachePathsSkipped,
      chromiumCacheReadErrors: canaryScan.chromiumCacheReadErrors,
      canaryScanComplete: canaryScan.complete,
      credentialCanaryMatches: canaryScan.matches,
      credentialCanaryAbsentFromPackagedProcessOutput: true,
    };
    const serialized = `${JSON.stringify(summary, null, 2)}\n`;
    if (canaryStrings.some((value) => serialized.includes(value)))
      throw new Error("Credential canary appeared in the E2E summary.");
    await writeFile(summaryPath, serialized, "utf8");
    summaryWritten = true;
    if (!canaryScan.complete || canaryScan.matches !== 0 || Object.values(cases).some((value) => value !== true)) {
      throw new Error("Media production packaged E2E assertions failed.");
    }
    process.stdout.write(
      `${JSON.stringify({ status: "passed", summary: path.basename(summaryPath), phases: phases.length, canaryMatches: canaryScan.matches })}\n`,
    );
  } finally {
    if (!summaryWritten) {
      try {
        const canaryScan = await scanMediaCanaryTree(root, canaryBytes);
        await mkdir(path.dirname(summaryPath), { recursive: true });
        await writeFile(
          summaryPath,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              sourceCommit: process.env.SITEINDEX_MEDIA_E2E_SOURCE_COMMIT ?? "local",
              status: "failed",
              completedPhaseCount: Object.keys(phaseResults).length,
              localFileCountScanned: canaryScan.filesScanned,
              criticalFileCounts: canaryScan.criticalFilesRead,
              missingCriticalFileKindCount: canaryScan.missingCriticalKinds.length,
              criticalReadErrors: canaryScan.criticalReadErrors,
              otherReadErrors: canaryScan.otherReadErrors,
              chromiumCachePathsSkipped: canaryScan.chromiumCachePathsSkipped,
              chromiumCacheReadErrors: canaryScan.chromiumCacheReadErrors,
              canaryScanComplete: canaryScan.complete,
              credentialCanaryMatches: canaryScan.matches,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch {
        // Failure report remains intentionally content-free if the isolated tree cannot be scanned.
      }
    }
    image.server.closeAllConnections?.();
    wordpress.server.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => image.server.close(resolve)),
      new Promise((resolve) => wordpress.server.close(resolve)),
    ]);
    assertSafeTempRoot(root);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown packaged media production E2E failure."}\n`,
  );
  process.exitCode = 1;
});
