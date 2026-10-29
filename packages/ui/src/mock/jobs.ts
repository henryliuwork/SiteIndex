import type { JobName, RunLog, RunLogStep, SiteIndexApi } from "@siteindex/shared";
import { activeRuns, beginRun, delay, finishRun, finishedListeners, progressListeners, projectCenterError, projectCenterErrorMode, reply, runHistory } from "./context";

const stepsByJob: Partial<Record<JobName, string[]>> = {
  daily: ["load_project", "fetch_feed", "sync_products", "sync_inventory", "generate_report", "rebuild_views"],
  weekly: ["load_project", "fetch_sitemap", "crawl_pages", "classify_content", "rebuild_views"],
  monthly: ["load_project", "extract_design", "archive_report"],
  validate: ["load_project", "validate_files"],
  readme: ["load_project", "update_readme"],
  design: ["load_project", "extract_design"],
  "index-check": ["load_project", "check_index"],
  views: ["load_project", "rebuild_views"],
  init: ["load_project", "fetch_feed", "sync_products", "sync_inventory", "validate_files", "update_readme"],
};

function addMockSteps(run: RunLog): RunLog {
  if (run.steps?.length) return run;
  const keys = stepsByJob[run.job] ?? ["load_project", run.job];
  const failureIndex = run.status === "failed" ? keys.length - 1 : run.status === "partial" ? Math.max(0, keys.length - 1) : -1;
  const steps: RunLogStep[] = keys.map((key, index) => {
    const status = run.status === "skipped" ? "skipped" : index === failureIndex ? "failed" : "ok";
    return {
      key,
      status,
      message: status === "failed" ? run.errors?.[0] ?? "步骤未完成，请查看运行日志。" : status === "skipped" ? "任务未在指定执行设备运行。" : "步骤已完成。",
    };
  });
  return { ...run, steps };
}

export function createJobsMock(): SiteIndexApi["jobs"] {
  return {
    run: async (request) => { await delay(); return { runId: beginRun(request.projectPath, request.job) }; },
    cancel: (runId) => reply(() => finishRun(runId, "skipped")),
    history: (_id, limit = 20) => projectCenterErrorMode ? Promise.reject(projectCenterError()) : reply(() => runHistory.slice(0, limit).map(addMockSteps)),
    running: () => reply(() => {
      const active = [...activeRuns.entries()][0];
      return active ? { runId: active[0], job: active[1].job } : null;
    }),
    onProgress: (callback) => { progressListeners.add(callback); return () => progressListeners.delete(callback); },
    onFinished: (callback) => { finishedListeners.add(callback); return () => finishedListeners.delete(callback); },
  };
}
