import { isJobName, isRecord, type JobWorkerMessage, type JobWorkerStartMessage } from "./job-protocol.js";
import { executeJobWorkerMessage } from "./job-worker-execution.js";
import {
  sanitizeWorkerText,
  wordpressCredentialSensitiveValues,
  wordpressCredentialUsernames,
} from "./worker-output-sanitizer.js";

const port = process.parentPort;

if (!port) throw new Error("Job Worker 必须由 Electron utilityProcess 启动。");

function isStartMessage(value: unknown): value is JobWorkerStartMessage {
  if (!isRecord(value) || value.type !== "run" || !isRecord(value.request) || !isRecord(value.context)) return false;
  const allowedRequestKeys = new Set(["projectPath", "job", "trigger", "only", "date", "force", "dryRun", "skus"]);
  const allowedContextKeys = new Set([
    "deviceId",
    "deviceName",
    "cacheDir",
    "browserPath",
    "wordpressCredential",
    "testOnlyAllowLoopbackHttp",
  ]);
  if (Object.keys(value.request).some((key) => !allowedRequestKeys.has(key))) return false;
  if (Object.keys(value.context).some((key) => !allowedContextKeys.has(key))) return false;
  if (
    value.context.testOnlyAllowLoopbackHttp !== undefined &&
    typeof value.context.testOnlyAllowLoopbackHttp !== "boolean"
  ) return false;
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

let active = false;

port.on("message", (event) => {
  if (active || !isStartMessage(event.data)) return;
  active = true;
  void executeJobWorkerMessage(event.data, port).catch((error: unknown) => {
    const credential = event.data.context.wordpressCredential;
    port.postMessage({
      type: "fatal",
      message: sanitizeWorkerText(
        error instanceof Error ? error.message : String(error),
        credential ? wordpressCredentialSensitiveValues(credential) : [],
        credential ? wordpressCredentialUsernames(credential) : [],
      ),
    } satisfies JobWorkerMessage);
  });
});

port.postMessage({ type: "ready" } satisfies JobWorkerMessage);
