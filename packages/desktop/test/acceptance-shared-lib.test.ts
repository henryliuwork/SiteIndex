import { describe, expect, it, vi } from "vitest";
import { assertNormalExit, assertPersisted, createReport, redactEvidence, verifyInstallerDigest } from "../scripts/acceptance/report.mjs";
import { cleanupProfile, isolatedEnvironment, waitForObserved } from "../scripts/acceptance/session.mjs";

const run = { baseline: { ref: "v0.8.0", sha256: "a".repeat(64) },
  candidate: { ref: "v0.8.5-rc.1", sha256: "b".repeat(64) },
  runner: "synthetic", osBuild: "test" };

describe("shared packaged acceptance primitives", () => {
  it("waits for observed state and reports a bounded timeout", async () => {
    let attempts = 0;
    expect(await waitForObserved(() => ++attempts === 3, { timeoutMs: 100, intervalMs: 1 })).toBe(true);
    await expect(waitForObserved(() => false, { timeoutMs: 2, intervalMs: 1, label: "IPC readback" }))
      .rejects.toThrow("Timed out waiting for IPC readback");
  });

  it("isolates process environment and removes inherited service credentials", () => {
    const env = isolatedEnvironment({ root: "/tmp/synthetic", layout: {
      appDataRoot: "/tmp/synthetic/roaming", localAppDataRoot: "/tmp/synthetic/local",
      userProfileRoot: "/tmp/synthetic/user", homeRoot: "/tmp/synthetic/home",
      tempRoot: "/tmp/synthetic/temp", tmpRoot: "/tmp/synthetic/tmp",
    } }, { GH_TOKEN: "CANARY_TOKEN", PATH: "synthetic-bin" });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.APPDATA).toBe("/tmp/synthetic/roaming");
    expect(env.PATH).toBe("synthetic-bin");
  });

  it("retries EBUSY cleanup, but reports unrecoverable cleanup separately", async () => {
    const remove = vi.fn().mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
      .mockResolvedValueOnce(undefined);
    expect(await cleanupProfile({ root: "/tmp/synthetic" }, { remove, intervalMs: 1 })).toEqual({ status: "passed", retries: 1 });
    const failed = await cleanupProfile({ root: "/tmp/synthetic" }, {
      remove: vi.fn().mockRejectedValue(Object.assign(new Error("blocked"), { code: "EACCES" })),
    });
    expect(failed).toMatchObject({ status: "harness_error", retries: 0 });
  });

  it("negative self-test: a successful UI save without file persistence fails as assertion_failed", async () => {
    const recorder = createReport(run);
    const stored = { device_name: "old synthetic name" };
    const submitted = { device_name: "new synthetic name" };
    try {
      assertPersisted(stored, submitted);
      recorder.add({ id: "setting-1", phase: "readback", status: "passed" });
    } catch (error) {
      await recorder.failure({ id: "setting-1", phase: "readback", kind: "assertion_failed", error });
    }
    expect(recorder.report.items).toMatchObject([{ id: "setting-1", status: "assertion_failed" }]);
    expect(recorder.report.items[0]?.evidence[0]?.message).toContain("not persisted");
  });

  it("negative self-test: forced termination violates H1", async () => {
    const recorder = createReport(run);
    try {
      assertNormalExit({ method: "kill", exitCode: 1, remainingProcesses: 0 });
      recorder.add({ id: "H1", phase: "shutdown", status: "passed" });
    } catch (error) {
      await recorder.failure({ id: "H1", phase: "shutdown", kind: "assertion_failed", error });
    }
    expect(recorder.report.items).toMatchObject([{ id: "H1", status: "assertion_failed" }]);
    expect(recorder.report.items[0]?.evidence[0]?.message).toContain("H1 violation");
  });

  it("redacts canaries in messages, stacks, IPC and console without losing status", async () => {
    const recorder = createReport({ ...run, secrets: ["CANARY_VALUE"] });
    await recorder.failure({ id: "setting-2", phase: "save", kind: "assertion_failed",
      error: Object.assign(new Error("password=CANARY_VALUE at C:\\Users\\Alice\\test"),
        { stack: "Bearer CANARY_VALUE" }),
      consoleMessages: ["token: CANARY_VALUE"], lastIpc: { password: "CANARY_VALUE", method: "settings.save" } });
    const serialized = JSON.stringify(recorder.report);
    expect(serialized).not.toContain("CANARY_VALUE");
    expect(serialized).not.toContain("Alice");
    expect(serialized).toContain("assertion_failed");
    expect(redactEvidence("https://shop.example.test/path")).toBe("https://shop.example.test/path");
    expect(redactEvidence("https://real.example.com/path/private")).toBe("[redacted-url]");
  });

  it("attaches a screenshot reference and recent IPC to failure evidence", async () => {
    const screenshot = vi.fn().mockResolvedValue(undefined);
    const recorder = createReport(run);
    await recorder.failure({ id: "setting-3", phase: "readback", kind: "assertion_failed",
      error: new Error("readback differed"), page: { screenshot }, outputDir: "/tmp/synthetic",
      consoleMessages: ["synthetic console"], lastIpc: { method: "settings.get", result: "synthetic" } });
    expect(screenshot).toHaveBeenCalledWith({ path: expect.stringMatching(/setting-3\.png$/u) });
    expect(recorder.report.items[0]?.evidence).toMatchObject([
      { console: ["synthetic console"], last_ipc: { method: "settings.get" } },
      { screenshot: "setting-3.png" },
    ]);
  });

  it("masks the username field in row 82 failure screenshots", async () => {
    const screenshot = vi.fn().mockResolvedValue(undefined);
    const username = { synthetic: "named username field" };
    const getByRole = vi.fn(() => username);
    const recorder = createReport({ ...run, secrets: ["synthetic-runtime-password"] });
    await recorder.failure({ id: 82, phase: "baseline-ui", kind: "assertion_failed",
      error: new Error("synthetic-runtime-password"), page: { screenshot, getByRole },
      outputDir: "/tmp/synthetic" });
    expect(screenshot).toHaveBeenCalledWith({ path: expect.stringMatching(/82\.png$/u), mask: [username] });
    expect(getByRole).toHaveBeenCalledWith("textbox", { name: "WordPress 用户名" });
    expect(JSON.stringify(recorder.report)).not.toContain("synthetic-runtime-password");
  });

  it("requires both installer digests before recording any acceptance", () => {
    expect(() => createReport({ ...run, candidate: { ref: "candidate" } })).toThrow("SHA256");
  });

  it("rejects a mismatched installer hash before any app can launch", async () => {
    await expect(verifyInstallerDigest(import.meta.filename, "a".repeat(64))).rejects.toThrow("SHA256 mismatch");
  });
});
