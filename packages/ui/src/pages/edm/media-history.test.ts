import type { RunLog } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import type { EdmMediaRunSnapshot } from "./media-job-monitor";
import { EDM_MEDIA_HISTORY_LIMIT, selectEdmMediaDisplay } from "./media-history";

function snapshot(startedAt: number, runId = "media-run-reused", state: EdmMediaRunSnapshot["state"] = "finished"): EdmMediaRunSnapshot {
  return { projectId: "demo", projectName: "虚构项目", skus: ["DEMO-001"], startedAt, runId, state, progress: "", result: {
    runId, job: "media", status: "ok", exitCode: 0, summary: "已处理", media_requested_skus: ["DEMO-001"],
    media_batch_state: "complete", media_results: [{ sku: "DEMO-001", status: "uploaded" }], media_unknown_skus: [], media_not_started_skus: [],
  } };
}

function history(runId: string, startedAt: number, job: RunLog["job"] = "media"): RunLog {
  return {
    run_id: runId, job, started_at: new Date(startedAt).toISOString(), finished_at: new Date(startedAt + 1000).toISOString(), status: "ok",
    ...(job === "media" ? {
      media_requested_skus: ["DEMO-001"], media_batch_state: "complete" as const,
      media_results: [{ sku: "DEMO-001", status: "recorded" as const }], media_unknown_skus: [], media_not_started_skus: [],
    } : {}),
  };
}

describe("selectEdmMediaDisplay", () => {
  it("活动快照优先显示，并在历史读取中不被覆盖", () => {
    const active = snapshot(10_000, "media-running", "running");
    expect(selectEdmMediaDisplay(active, [history("external", 50_000)], "loading", 80_000)).toEqual({ kind: "snapshot", snapshot: active });
  });

  it("重新进入时先隐藏旧终态，避免历史查询期间旧结果闪现", () => {
    expect(selectEdmMediaDisplay(snapshot(10_000), undefined, "loading", 20_000)).toEqual({ kind: "loading" });
  });

  it("外部较新的历史覆盖终态快照，即使 producer 重用了 runId", () => {
    const oldSnapshot = snapshot(1_000_000, "daily-media");
    const externalRun = history("daily-media", 1_000_000 + 24 * 60 * 60 * 1000);
    const selected = selectEdmMediaDisplay(oldSnapshot, [externalRun], "success", 2_000_000);
    expect(selected).toEqual({ kind: "history", run: externalRun });
  });

  it("没有 runId 的启动失败快照不覆盖最近持久化历史", () => {
    const currentFailure: EdmMediaRunSnapshot = {
      ...snapshot(2_000_000, "unused", "failed"), runId: undefined, result: undefined, error: "启动失败",
    };
    const persistedRun = history("persisted-media", 1_000_000);
    expect(selectEdmMediaDisplay(currentFailure, [persistedRun], "success", 1_500_000)).toEqual({ kind: "history", run: persistedRun });
  });

  it("同一 runId 只有可信时间接近时才视为同一执行", () => {
    const runTime = 1_000_000;
    const matchingRun = history("daily-media", runTime + 30_000);
    expect(selectEdmMediaDisplay(snapshot(runTime, "daily-media"), [matchingRun], "success", runTime - 1000).kind).toBe("snapshot");
    const reusedRun = history("daily-media", runTime + 10 * 60_000);
    expect(selectEdmMediaDisplay(snapshot(runTime, "daily-media"), [reusedRun], "success", runTime - 1000)).toEqual({ kind: "history", run: reusedRun });
  });

  it("旧快照早于已截断的最近 100 条历史窗口时不冒充最近记录", () => {
    const oldestReturned = 5_000_000;
    const recentRuns = Array.from({ length: EDM_MEDIA_HISTORY_LIMIT }, (_, index) => history(`job-${index}`, oldestReturned + index * 1000, "weekly"));
    expect(selectEdmMediaDisplay(snapshot(oldestReturned - 60_000), recentRuns, "success", oldestReturned + 1)).toEqual({ kind: "history-truncated" });
  });

  it("没有任何可显示的历史或快照时返回空状态", () => {
    expect(selectEdmMediaDisplay(null, [], "success", 100)).toEqual({ kind: "empty" });
  });
});
