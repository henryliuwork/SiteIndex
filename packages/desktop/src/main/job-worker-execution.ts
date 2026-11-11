import { createCoreService, type CoreService, type CoreServiceContext } from "@siteindex/core";
import {
  EXIT,
  type JobProgress,
  type JobRequest,
  type JobResult,
  type ProgressReporter,
  type ProjectId,
} from "@siteindex/shared";
import path from "node:path";
import { type JobWorkerMessage, type JobWorkerStartMessage } from "./job-protocol.js";
import { resolveJobRunId } from "./job-run-id.js";
import {
  sanitizeJobProgress,
  sanitizeJobResult,
  sanitizeWorkerText,
  wordpressCredentialSensitiveValues,
  wordpressCredentialUsernames,
} from "./worker-output-sanitizer.js";

export interface JobWorkerMessagePort {
  postMessage(message: JobWorkerMessage): void;
}

export interface JobWorkerExecutionDependencies {
  createCore?(context: CoreServiceContext): CoreService;
  resolveRunId?: typeof resolveJobRunId;
  now?: () => Date;
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

function validCoreStartedAt(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

export async function executeJobWorkerMessage(
  message: JobWorkerStartMessage,
  port: JobWorkerMessagePort,
  dependencies: JobWorkerExecutionDependencies = {},
): Promise<void> {
  const projectPath = path.resolve(message.request.projectPath);
  const sensitiveValues = message.context.wordpressCredential
    ? wordpressCredentialSensitiveValues(message.context.wordpressCredential)
    : [];
  const sensitiveUsernames = message.context.wordpressCredential
    ? wordpressCredentialUsernames(message.context.wordpressCredential)
    : [];
  const request: JobRequest = { ...message.request, projectPath, trigger: message.request.trigger };
  let coreMediaRunId: string | null = null;
  let runId: string | null = null;

  const coreContext: CoreServiceContext & {
    wordpressCredential?: NonNullable<JobWorkerStartMessage["context"]["wordpressCredential"]>;
  } = {
    resolveProject: () => projectPath,
    deviceId: message.context.deviceId,
    deviceName: message.context.deviceName,
    cacheDir: message.context.cacheDir,
    browserExecutablePath: message.context.browserPath ?? null,
    ...(message.context.testOnlyAllowLoopbackHttp === true ? { testOnlyAllowLoopbackHttp: true } : {}),
    ...(message.context.wordpressCredential ? { wordpressCredential: message.context.wordpressCredential } : {}),
    ...(request.job === "media"
      ? {
          onJobStarted: (coreRunId: string, startedAt: string) => {
            if (!coreRunId.trim() || !validCoreStartedAt(startedAt)) {
              throw new Error("Core 未提供有效的媒体任务执行 ID 或启动时间。");
            }
            if (coreMediaRunId !== null) {
              throw new Error("Core 重复报告媒体任务启动。");
            }
            coreMediaRunId = coreRunId;
            runId = coreRunId;
            port.postMessage({ type: "started", runId: coreRunId, startedAt });
          },
        }
      : {}),
  };

  const postFatal = (error: unknown) => {
    port.postMessage({
      type: "fatal",
      message: sanitizeWorkerText(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
        sensitiveUsernames,
      ),
    });
  };

  try {
    const core = (dependencies.createCore ?? createCoreService)(coreContext);
    if (request.job !== "media") {
      runId = await (dependencies.resolveRunId ?? resolveJobRunId)(request);
      port.postMessage({
        type: "started",
        runId,
        startedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      });
    }

    const report: ProgressReporter = (progress) => {
      if (!runId) throw new Error("Core 在报告媒体任务进度前未发送启动事件。");
      const event: JobProgress = {
        ...progress,
        runId,
        projectPath,
        job: request.job,
        at: (dependencies.now ?? (() => new Date()))().toISOString(),
      };
      port.postMessage({
        type: "progress",
        progress: sanitizeJobProgress(event, sensitiveValues, sensitiveUsernames),
      });
    };

    const result = await core.runJob(request, report);
    if (request.job === "media") {
      if (!coreMediaRunId) {
        postFatal(new Error("Core 未报告媒体任务启动 ID；Desktop 未生成替代 ID。"));
        return;
      }
      if (result.runId !== coreMediaRunId) {
        postFatal(new Error("Core 媒体任务结果 ID 与启动 ID 不一致。"));
        return;
      }
    }
    const finalRunId = runId;
    if (!finalRunId) {
      postFatal(new Error("Job 执行 ID 不可用。"));
      return;
    }
    const oosRate =
      request.job === "daily" && result.status !== "failed" ? await currentOutOfStockRate(core, projectPath) : null;
    port.postMessage({
      type: "finished",
      result: sanitizeJobResult(result, sensitiveValues, sensitiveUsernames),
      oosRate,
    });
  } catch (error) {
    const detail = sanitizeWorkerText(
      error instanceof Error ? error.message : String(error),
      sensitiveValues,
      sensitiveUsernames,
    );
    if (request.job === "media" && !runId) {
      postFatal(new Error("Core 未报告媒体任务启动 ID；Desktop 未生成替代 ID。"));
      return;
    }
    const finalRunId = runId;
    if (!finalRunId) {
      postFatal(error);
      return;
    }
    if (request.job === "media") {
      // Let JobManager distinguish an abnormal worker exit from a Core result and recover
      // the durable per-SKU checkpoint after the utilityProcess has actually exited.
      postFatal(error);
      return;
    }
    port.postMessage({
      type: "finished",
      oosRate: null,
      result: {
        runId: finalRunId,
        job: request.job,
        status: "failed",
        exitCode: EXIT.SOURCE_FAILED,
        summary: "Job 执行失败。",
        errors: [detail],
        ...mediaFailureRecovery(request),
      },
    });
  }
}

function mediaFailureRecovery(
  request: JobRequest,
): Partial<
  Pick<
    JobResult,
    "media_requested_skus" | "media_batch_state" | "media_results" | "media_unknown_skus" | "media_not_started_skus"
  >
> {
  if (request.job !== "media") return {};
  const skus = [...new Set(request.skus ?? [])];
  return {
    media_requested_skus: skus,
    media_batch_state: "outcome_unknown",
    media_results: [],
    media_unknown_skus: skus,
    media_not_started_skus: [],
  };
}
