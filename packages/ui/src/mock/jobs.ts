import type { SiteIndexApi } from "@siteindex/shared";
import { activeRuns, beginRun, delay, finishRun, finishedListeners, progressListeners, projectCenterError, projectCenterErrorMode, reply, runHistory } from "./context";

export function createJobsMock(): SiteIndexApi["jobs"] {
  return {
    run: async (request) => { await delay(); return { runId: beginRun(request.projectPath, request.job) }; },
    cancel: (runId) => reply(() => finishRun(runId, "skipped")),
    history: (_id, limit = 20) => projectCenterErrorMode ? Promise.reject(projectCenterError()) : reply(() => runHistory.slice(0, limit)),
    running: () => reply(() => {
      const active = [...activeRuns.entries()][0];
      return active ? { runId: active[0], job: active[1].job } : null;
    }),
    onProgress: (callback) => { progressListeners.add(callback); return () => progressListeners.delete(callback); },
    onFinished: (callback) => { finishedListeners.add(callback); return () => finishedListeners.delete(callback); },
  };
}
