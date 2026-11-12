// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginEdmExportAttempt,
  EDM_EXPORT_RECONCILIATION_VERIFIED,
  getEdmExportSafetyState,
  keepEdmExportAttemptBlocked,
  resolveEdmExportAttempt,
  subscribeEdmExportSafety,
} from "./export-retry-state";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("EDM 导出结果核验门闩", () => {
  it("按项目隔离并跨页面重载持久阻止未确认结果的重试", () => {
    expect(getEdmExportSafetyState("demo-export-a")).toBe("ready");
    const attemptId = beginEdmExportAttempt("demo-export-a");
    expect(attemptId).toBeTruthy();
    keepEdmExportAttemptBlocked("demo-export-a", attemptId!);

    expect(getEdmExportSafetyState("demo-export-a")).toBe("blocked");
    expect(getEdmExportSafetyState("demo-export-b")).toBe("ready");
    expect(JSON.parse(window.localStorage.getItem("siteindex:edm-export-attempt:demo-export-a") ?? "{}").state).toBe("unknown");
  });

  it("其它窗口更新本机存储时通知当前页面刷新门闩状态", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEdmExportSafety("demo-export-storage", listener);
    window.dispatchEvent(new StorageEvent("storage", { key: "siteindex:edm-export-attempt:demo-export-storage" }));

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("存储失败时无法开始 IPC 调用并保持当前 renderer 的门闩关闭", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });

    expect(beginEdmExportAttempt("demo-export-storage-failure")).toBeNull();
    expect(getEdmExportSafetyState("demo-export-storage-failure")).toBe("unavailable");
    vi.restoreAllMocks();
    expect(getEdmExportSafetyState("demo-export-storage-failure")).toBe("ready");
  });

  it("确定结果后解除门闩；后端核验经验证后可恢复历史未知结果", () => {
    const attemptId = beginEdmExportAttempt("demo-export-resolved");
    expect(attemptId).toBeTruthy();
    expect(resolveEdmExportAttempt("demo-export-resolved", attemptId!)).toBe(true);
    expect(getEdmExportSafetyState("demo-export-resolved")).toBe("ready");

    const uncertainAttempt = beginEdmExportAttempt("demo-export-verified-recovery");
    expect(uncertainAttempt).toBeTruthy();
    keepEdmExportAttemptBlocked("demo-export-verified-recovery", uncertainAttempt!);
    expect(EDM_EXPORT_RECONCILIATION_VERIFIED).toBe(false);
    expect(getEdmExportSafetyState("demo-export-verified-recovery")).toBe("blocked");
    expect(getEdmExportSafetyState("demo-export-verified-recovery", true)).toBe("ready");
    expect(beginEdmExportAttempt("demo-export-verified-recovery", true)).toBeTruthy();
  });

  it("取消已确认但无法删除本地门闩时，应用模块重载后仍按持久标记暂停", async () => {
    const projectId = "demo-export-cancelled-marker";
    const markerKey = "siteindex:edm-export-attempt:demo-export-cancelled-marker";
    const originalRemoveItem = window.localStorage.removeItem.bind(window.localStorage);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
      if (key === markerKey) throw new Error("local storage remove unavailable");
      originalRemoveItem(key);
    });

    const attemptId = beginEdmExportAttempt(projectId);
    expect(attemptId).toBeTruthy();
    expect(resolveEdmExportAttempt(projectId, attemptId!)).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(markerKey) ?? "{}").state).toBe("pending");
    expect(getEdmExportSafetyState(projectId)).toBe("blocked");

    vi.resetModules();
    const reloaded = await import("./export-retry-state");
    expect(reloaded.getEdmExportSafetyState(projectId)).toBe("blocked");
  });

  it("旧 attempt 的完成回调不能清除另一个窗口写入的新 attempt 标记", () => {
    const oldAttempt = beginEdmExportAttempt("demo-export-race");
    expect(oldAttempt).toBeTruthy();
    const newerAttempt = `${oldAttempt}-newer`;
    window.localStorage.setItem("siteindex:edm-export-attempt:demo-export-race", JSON.stringify({ state: "pending", attemptId: newerAttempt }));

    expect(resolveEdmExportAttempt("demo-export-race", oldAttempt!)).toBe(false);
    expect(window.localStorage.getItem("siteindex:edm-export-attempt:demo-export-race")).toContain(newerAttempt);
    expect(getEdmExportSafetyState("demo-export-race")).toBe("blocked");
  });
});
