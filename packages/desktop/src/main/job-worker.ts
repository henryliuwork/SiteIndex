import { createCoreService, type CoreService } from "@siteindex/core";
import {
  EXIT,
  PATHS,
  type JobProgress,
  type JobRequest,
  type ProgressReporter,
  type ProjectId,
} from "@siteindex/shared";
import path from "node:path";
import { isJobName, isRecord, type JobWorkerMessage, type JobWorkerStartMessage } from "./job-protocol.js";

const port = process.parentPort;

if (!port) throw new Error("Job Worker 必须由 Electron utilityProcess 启动。");

function localDate(timezone: string, now = new Date()): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

async function runIdFor(request: JobWorkerStartMessage["request"]): Promise<string> {
  if (request.date) return `${request.date}-${request.job}`;
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path.join(path.resolve(request.projectPath), PATHS.site), "utf8");
    const config: unknown = JSON.parse(content);
    const timezone = isRecord(config) && typeof config.timezone === "string" ? config.timezone : "UTC";
    return `${localDate(timezone)}-${request.job}`;
  } catch {
    return `${new Date().toISOString().slice(0, 10)}-${request.job}`;
  }
}

function isStartMessage(value: unknown): value is JobWorkerStartMessage {
  if (!isRecord(value) || value.type !== "run" || !isRecord(value.request) || !isRecord(value.context)) return false;
  return (
    typeof value.request.projectPath === "string" &&
    isJobName(value.request.job) &&
    (value.request.trigger === "schedule" || value.request.trigger === "manual" || value.request.trigger === "cli") &&
    typeof value.context.deviceId === "string" &&
    typeof value.context.deviceName === "string" &&
    typeof value.context.cacheDir === "string"
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
  void run(event.data).catch((error: unknown) => {
    port.postMessage({
      type: "fatal",
      message: error instanceof Error ? error.message : String(error),
    } satisfies JobWorkerMessage);
  });
});

port.postMessage({ type: "ready" } satisfies JobWorkerMessage);

async function run(message: JobWorkerStartMessage): Promise<void> {
  const projectPath = path.resolve(message.request.projectPath);
  const request: JobRequest = { ...message.request, projectPath, trigger: message.request.trigger };
  const core = createCoreService({
    resolveProject: () => projectPath,
    deviceId: message.context.deviceId,
    deviceName: message.context.deviceName,
    cacheDir: message.context.cacheDir,
  });
  const runId = await runIdFor(request);
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
    port.postMessage({ type: "progress", progress: event } satisfies JobWorkerMessage);
  };

  try {
    const result = await core.runJob(request, report);
    const oosRate =
      request.job === "daily" && result.status !== "failed" ? await currentOutOfStockRate(core, projectPath) : null;
    port.postMessage({ type: "finished", result, oosRate } satisfies JobWorkerMessage);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
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
