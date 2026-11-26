import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { credentialAdapter, readSystemTask, scheduleAdapter, sensitiveSystemHandlers, taskAbsent } from
  "../scripts/acceptance/credential-schedule-adapters.mjs";

describe("v0.8.5 sensitive and system acceptance adapters", () => {
  it("requires runtime synthetic credentials and exposes complete row handlers", () => {
    assert.throws(() => credentialAdapter({ username: "", applicationPassword: "" }), /required/u);
    const handlers = sensitiveSystemHandlers([82, 83], {
      username: "synthetic-only", applicationPassword: "synthetic-runtime-canary",
    });
    for (const id of [82, 83]) {
      for (const phase of ["baselineUi", "verifyBaselineIpc", "verifyBaselineFile",
        "candidateUi", "verifyCandidateIpc", "verifyCandidateFile"]) {
        assert.equal(typeof handlers[id][phase], "function", `row ${id} ${phase}`);
      }
    }
    assert.equal(typeof scheduleAdapter().cleanupSystem, "function");
    assert.throws(() => sensitiveSystemHandlers([81], {}), /Unsupported/u);
  });

  it("reads five task XML fields without exposing raw XML", () => {
    const run = vi.fn(() => ({ status: 0, stdout: JSON.stringify({
      command: "C:\\isolated\\SiteIndex.exe",
      arguments: '--run-job "C:\\isolated\\project" daily',
      workingDirectory: "C:\\isolated\\project",
      startBoundary: "2026-11-26T17:44:00",
      triggerCount: 1, actionCount: 1, enabled: "true",
      week: ["Tuesday", "Thursday"], month: [],
    }), stderr: "" }));
    const task = readSystemTask("daily", run);
    assert.equal(task.time, "17:44");
    assert.deepEqual(task.weekdays, ["Tuesday", "Thursday"]);
    assert.equal(task.enabled, true);
    assert.equal("xml" in task, false);
    assert.equal(run.mock.calls[0][0], "powershell.exe");
    assert.match(run.mock.calls[0][2].env.SITEINDEX_TASK_NAME, /synthetic-task83-project-daily$/u);
  });

  it("distinguishes absent tasks from a scheduler command error", () => {
    const missing = vi.fn(() => ({ status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }));
    assert.equal(taskAbsent("weekly", missing), true);
    const invalid = vi.fn(() => ({ status: 2, stdout: "", stderr: "Access denied" }));
    assert.throws(() => taskAbsent("weekly", invalid), /absence query failed/u);
  });
});
