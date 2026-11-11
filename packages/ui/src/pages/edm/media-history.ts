import type { RunLog } from "@siteindex/shared";
import type { EdmMediaRunSnapshot } from "./media-job-monitor";

export const EDM_MEDIA_HISTORY_LIMIT = 100;

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
    .filter((run) => run.job === "media" && Number.isFinite(Date.parse(run.started_at)))
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))[0];
}

/**
 * Selects the newest evidenced media result. runId is not an execution identity:
 * legacy producers may reuse it, so the trusted start timestamps decide which
 * terminal result is newer.
 */
export function selectEdmMediaDisplay(
  snapshot: EdmMediaRunSnapshot | null,
  history: readonly RunLog[] | undefined,
  historyState: MediaHistoryQueryState,
  pageMountedAt: number,
): EdmMediaDisplaySelection {
  const latestHistory = latestMediaRun(history ?? []);
  if (snapshot && isActive(snapshot)) {
    if (latestHistory && Date.parse(latestHistory.started_at) > snapshot.startedAt) {
      return { kind: "history", run: latestHistory };
    }
    return { kind: "snapshot", snapshot };
  }

  const snapshotIsCurrentVisit = Boolean(snapshot && snapshot.startedAt >= pageMountedAt);
  if (historyState === "loading") {
    return snapshotIsCurrentVisit && snapshot ? { kind: "snapshot", snapshot } : { kind: "loading" };
  }
  const startupFailure = snapshot?.state === "failed" && !snapshot.runId && !snapshot.result;
  if (historyState === "error" && !latestHistory) {
    return snapshotIsCurrentVisit && snapshot ? { kind: "snapshot", snapshot } : { kind: "history-error" };
  }
  if (startupFailure && latestHistory) return { kind: "history", run: latestHistory };
  if (snapshot && latestHistory) {
    const historyStartedAt = Date.parse(latestHistory.started_at);
    if (snapshot.startedAt > historyStartedAt) return { kind: "snapshot", snapshot };
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
