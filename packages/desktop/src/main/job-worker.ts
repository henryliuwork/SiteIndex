import { createCoreService, type CoreService, type CoreServiceContext } from "@siteindex/core";
import { EXIT, type JobProgress, type JobRequest, type ProgressReporter, type ProjectId } from "@siteindex/shared";
import path from "node:path";
import { isJobName, isRecord, type JobWorkerMessage, type JobWorkerStartMessage } from "./job-protocol.js";
import { resolveJobRunId } from "./job-run-id.js";
import {
  sanitizeJobProgress,
  sanitizeJobResult,
  sanitizeWorkerText,
  wordpressCredentialSensitiveValues,
  wordpressCredentialUsernames,
} from "./worker-output-sanitizer.js";

const port = process.parentPort;

if (!port) throw new Error("Job Worker 必须由 Electron utilityProcess 启动。");

function isStartMessage(value: unknown): value is JobWorkerStartMessage {
  if (!isRecord(value) || value.type !== "run" || !isRecord(value.request) || !isRecord(value.context)) return false;
  const allowedRequestKeys = new Set(["projectPath", "job", "trigger", "only", "date", "force", "dryRun", "skus"]);
  const allowedContextKeys = new Set(["deviceId", "deviceName", "cacheDir", "browserPath", "wordpressCredential"]);
  if (Object.keys(value.request).some((key) => !allowedRequestKeys.has(key))) return false;
  if (Object.keys(value.context).some((key) => !allowedContextKeys.has(key))) return false;
  const hasCredential = value.context.wordpressCredential !== undefined;
  if (
    hasCredential &&
    (!isRecord(value.context.wordpressCredential) ||
      typeof value.context.wordpressCredential.username !== "string" ||
      !value.context.wordpressCredential.username.trim() ||
      typeof value.context.wordpressCredential.applicationPassword !== "string" ||
      !value.context.wordpressCredential.applicationPassword.trim())
  ) {
    return false;
  }
  if ((value.request.job === "media") !== hasCredential) return false;
  if (
    value.request.job === "media" &&
    (!Array.isArray(value.request.skus) || value.request.skus.some((sku) => typeof sku !== "string"))
  ) {
    return false;
  }
  return (
    typeof value.request.projectPath === "string" &&
    isJobName(value.request.job) &&
    (value.request.trigger === "schedule" || value.request.trigger === "manual" || value.request.trigger === "cli") &&
    typeof value.context.deviceId === "string" &&
    typeof value.context.deviceName === "string" &&
    typeof value.context.cacheDir === "string" &&
    (value.context.browserPath === undefined ||
      value.context.browserPath === null ||
      typeof value.context.browserPath === "string")
  );
}

async function currentOutOfStockRate(core: CoreService, projectPath: string): Promise<number | null> {
  try {
    const projectId = path.basename(projectPath) as ProjectId;
    const summary = await core.inventory.summary(projectId, 14);
    const total = Number(summary.kpis.find(({ key }) => key === "total")?.value);
    const outOfStock = Number(summary.kpis.find(({ key }) => key === "out_of_stock")?.value);
    return Number.isFinite(total) && total > 0 && Number.isFinite(outOfStock) ? outOfStock / total : null;
  } catch {
    return null;
  }
}

let active = false;

port.on("message", (event) => {
  if (active || !isStartMessage(event.data)) return;
  active = true;
  const sensitiveValues = event.data.context.wordpressCredential
    ? wordpressCredentialSensitiveValues(event.data.context.wordpressCredential)
    : [];
  const sensitiveUsernames = event.data.context.wordpressCredential
    ? wordpressCredentialUsernames(event.data.context.wordpressCredential)
    : [];
  void run(event.data).catch((error: unknown) => {
    port.postMessage({
      type: "fatal",
      message: sanitizeWorkerText(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
        sensitiveUsernames,
      ),
    } satisfies JobWorkerMessage);
  });
});

port.postMessage({ type: "ready" } satisfies JobWorkerMessage);

async function run(message: JobWorkerStartMessage): Promise<void> {
  const projectPath = path.resolve(message.request.projectPath);
  const sensitiveValues = message.context.wordpressCredential
    ? wordpressCredentialSensitiveValues(message.context.wordpressCredential)
    : [];
  const sensitiveUsernames = message.context.wordpressCredential
    ? wordpressCredentialUsernames(message.context.wordpressCredential)
    : [];
  const request: JobRequest = { ...message.request, projectPath, trigger: message.request.trigger };
  const coreContext: CoreServiceContext & {
    wordpressCredential?: NonNullable<JobWorkerStartMessage["context"]["wordpressCredential"]>;
  } = {
    resolveProject: () => projectPath,
    deviceId: message.context.deviceId,
    deviceName: message.context.deviceName,
    cacheDir: message.context.cacheDir,
    browserExecutablePath: message.context.browserPath ?? null,
    ...(message.context.wordpressCredential ? { wordpressCredential: message.context.wordpressCredential } : {}),
  };
  const core = createCoreService(coreContext);
  const runId = await resolveJobRunId(request);
  const startedAt = new Date().toISOString();
  port.postMessage({ type: "started", runId, startedAt } satisfies JobWorkerMessage);

  const report: ProgressReporter = (progress) => {
    const event: JobProgress = {
      ...progress,
      runId,
      projectPath,
      job: request.job,
      at: new Date().toISOString(),
    };
    port.postMessage({
      type: "progress",
      progress: sanitizeJobProgress(event, sensitiveValues, sensitiveUsernames),
    } satisfies JobWorkerMessage);
  };

  try {
    const result = await core.runJob(request, report);
    const oosRate =
      request.job === "daily" && result.status !== "failed" ? await currentOutOfStockRate(core, projectPath) : null;
    port.postMessage({
      type: "finished",
      result: sanitizeJobResult(result, sensitiveValues, sensitiveUsernames),
      oosRate,
    } satisfies JobWorkerMessage);
  } catch (error) {
    const detail = sanitizeWorkerText(
      error instanceof Error ? error.message : String(error),
      sensitiveValues,
      sensitiveUsernames,
    );
    port.postMessage({
      type: "finished",
      oosRate: null,
      result: {
        runId,
        job: request.job,
        status: "failed",
        exitCode: EXIT.SOURCE_FAILED,
        summary: "Job 执行失败。",
        errors: [detail],
      },
    } satisfies JobWorkerMessage);
  }
}
