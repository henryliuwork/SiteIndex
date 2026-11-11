import type { RunLog } from "@siteindex/shared";
import type { EdmMediaRunSnapshot } from "./media-job-monitor";

export const EDM_MEDIA_HISTORY_LIMIT = 100;
const RUN_ID_TIME_TOLERANCE_MS = 2 * 60 * 1000;

export type EdmMediaDisplaySelection =
  | { kind: "snapshot"; snapshot: EdmMediaRunSnapshot }
  | { kind: "history"; run: RunLog }
  | { kind: "loading" }
  | { kind: "history-error" }
  | { kind: "empty" }
  | { kind: "history-truncated" };

export type MediaHistoryQueryState = "loading" | "success" | "error";

function isActive(snapshot: EdmMediaRunSnapshot): boolean {
  return snapshot.state === "starting" || snapshot.state === "running";
}

function latestMediaRun(history: readonly RunLog[]): RunLog | undefined {
  return history
    .filter((run) => run.job === "media")
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))[0];
}

/**
 * Selects the newest evidenced media result. runId alone is not treated as an
 * execution identity because legacy producers may reuse IDs; timestamps must
 * corroborate a same-ID match.
 */
export function selectEdmMediaDisplay(
  snapshot: EdmMediaRunSnapshot | null,
  history: readonly RunLog[] | undefined,
  historyState: MediaHistoryQueryState,
  pageMountedAt: number,
): EdmMediaDisplaySelection {
  if (snapshot && isActive(snapshot)) return { kind: "snapshot", snapshot };

  const snapshotIsCurrentVisit = Boolean(snapshot && snapshot.startedAt >= pageMountedAt);
  if (historyState === "loading") {
    return snapshotIsCurrentVisit && snapshot ? { kind: "snapshot", snapshot } : { kind: "loading" };
  }
  const latestHistory = latestMediaRun(history ?? []);
  const startupFailure = snapshot?.state === "failed" && !snapshot.runId && !snapshot.result;
  if (historyState === "error" && !latestHistory) {
    return snapshotIsCurrentVisit && snapshot ? { kind: "snapshot", snapshot } : { kind: "history-error" };
  }
  if (startupFailure && latestHistory) return { kind: "history", run: latestHistory };
  if (snapshot && latestHistory) {
    const historyStartedAt = Date.parse(latestHistory.started_at);
    const sameTimedExecution = snapshot.runId === latestHistory.run_id
      && Number.isFinite(historyStartedAt)
      && Math.abs(snapshot.startedAt - historyStartedAt) <= RUN_ID_TIME_TOLERANCE_MS;
    if (sameTimedExecution || snapshot.startedAt > historyStartedAt) return { kind: "snapshot", snapshot };
    return { kind: "history", run: latestHistory };
  }
  if (latestHistory) return { kind: "history", run: latestHistory };
  if (snapshot) {
    if (snapshotIsCurrentVisit) return { kind: "snapshot", snapshot };
    const runs = history ?? [];
    const oldestReturnedRun = runs.reduce<RunLog | undefined>((oldest, run) => {
      if (!oldest || Date.parse(run.started_at) < Date.parse(oldest.started_at)) return run;
      return oldest;
    }, undefined);
    if (runs.length >= EDM_MEDIA_HISTORY_LIMIT && oldestReturnedRun
      && snapshot.startedAt < Date.parse(oldestReturnedRun.started_at)) return { kind: "history-truncated" };
    return { kind: "snapshot", snapshot };
  }
  return { kind: "empty" };
}
