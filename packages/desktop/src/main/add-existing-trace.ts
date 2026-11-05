import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const ADD_EXISTING_TRACE_PHASES = [
  "path_check",
  "settings_registration",
  "catalog.refresh",
  "watcher.ready",
  "core.schedule.get",
  "core.runner.get",
  "core.projects.get",
  "scheduler.reconcile",
  "scheduler.task_list",
  "scheduler.task_query",
  "scheduler.task_apply",
  "scheduler.elevation_wait",
  "handler.total",
] as const;

export type AddExistingTracePhase = (typeof ADD_EXISTING_TRACE_PHASES)[number];
export interface AddExistingTiming {
  phase: AddExistingTracePhase;
  durationMs: number;
}

export type AddExistingTimingCallback = (phase: AddExistingTracePhase, durationMs: number) => void;
export type AddExistingTraceWriter = (timings: readonly AddExistingTiming[]) => Promise<void>;

export function createAddExistingTraceWriter(logsDirectory: string): AddExistingTraceWriter {
  const logPath = join(logsDirectory, "siteindex-trace.log");
  let writeQueue: Promise<void> = Promise.resolve();

  return async (timings) => {
    if (timings.length === 0) return;

    const totals = new Map<AddExistingTracePhase, number>();
    for (const { phase, durationMs } of timings) {
      if (!Number.isFinite(durationMs) || durationMs < 0) continue;
      totals.set(phase, (totals.get(phase) ?? 0) + durationMs);
    }
    if (totals.size === 0) return;

    const lines = ADD_EXISTING_TRACE_PHASES.flatMap((phase) => {
      const durationMs = totals.get(phase);
      return durationMs === undefined ? [] : [`projects.addExisting ${phase} ${durationMs.toFixed(1)}ms`];
    });
    const write = writeQueue.then(async () => {
      try {
        await mkdir(logsDirectory, { recursive: true });
        await appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
      } catch {
        // 诊断日志不可影响添加项目流程。
      }
    });
    writeQueue = write.catch(() => undefined);
    await write;
  };
}
