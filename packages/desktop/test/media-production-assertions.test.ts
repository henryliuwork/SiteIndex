import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { summarizePackagedPhaseFailure } from "../scripts/media-production-diagnostics.mjs";
import { runPackagedPhaseProcess } from "../scripts/media-production-phase-process.mjs";
import { hasMediaProgressEvidence } from "../src/main/media-production-assertions.js";
import { mediaTrafficChecks } from "../scripts/media-production-traffic.mjs";

describe("packaged media E2E progress assertion", () => {
  it("requires utilityProcess progress to reach the renderer through preload", () => {
    expect(hasMediaProgressEvidence(3, 2)).toBe(true);
    expect(hasMediaProgressEvidence(0, 2)).toBe(false);
    expect(hasMediaProgressEvidence(3, 0)).toBe(false);
  });
});

describe("packaged media E2E request evidence", () => {
  it("requires a slug lookup before a recovered retry and forbids a second create POST", () => {
    const checks = mediaTrafficChecks("retry-429", {
      mediaSlugLookups: 1,
      mediaCreatePosts: 0,
      mediaCreateResponses201: 0,
      uploadedObjects: 0,
    });

    expect(checks.slugLookupObserved).toBe(true);
    expect(checks.retryUsesSlugLookupWithoutCreate).toBe(true);
    expect(checks.matchesExpectedTraffic).toBe(true);
    expect(
      mediaTrafficChecks("retry-429", {
        mediaSlugLookups: 0,
        mediaCreatePosts: 0,
        mediaCreateResponses201: 0,
        uploadedObjects: 0,
      }).matchesExpectedTraffic,
    ).toBe(false);
  });

  it("checks successful 201 response baselines instead of inferring success from zero POSTs", () => {
    expect(
      mediaTrafficChecks("success", {
        mediaSlugLookups: 2,
        mediaCreatePosts: 2,
        mediaCreateResponses201: 2,
        uploadedObjects: 2,
      }).matchesExpectedTraffic,
    ).toBe(true);
    expect(
      mediaTrafficChecks("success", {
        mediaSlugLookups: 2,
        mediaCreatePosts: 2,
        mediaCreateResponses201: 0,
        uploadedObjects: 2,
      }).successfulCreateResponseCountMatches,
    ).toBe(false);
  });

  it("requires exactly one 429 response with Retry-After and no automatic resend", () => {
    const checks = mediaTrafficChecks("post-429", {
      mediaSlugLookups: 1,
      mediaCreatePosts: 1,
      mediaCreateResponses201: 0,
      uploadedObjects: 1,
      http429: 1,
      retryAfterOneSecondHeadersSent: 1,
    });

    expect(checks.http429CountMatches).toBe(true);
    expect(checks.retryAfterOneSecondHeaderSentOnce).toBe(true);
    expect(checks.createPostCountMatches).toBe(true);
    expect(checks.matchesExpectedTraffic).toBe(true);
    expect(
      mediaTrafficChecks("post-429", {
        mediaSlugLookups: 1,
        mediaCreatePosts: 2,
        mediaCreateResponses201: 0,
        uploadedObjects: 1,
        http429: 1,
        retryAfterOneSecondHeadersSent: 1,
      }).matchesExpectedTraffic,
    ).toBe(false);
  });
});

describe("packaged media E2E failure diagnostics", () => {
  it("extracts only a safe harness code and line count from child output", () => {
    const diagnostic = summarizePackagedPhaseFailure({
      phase: "success",
      exitCode: 1,
      resultReportStatus: "missing",
      capturedOutput:
        "media-production:success:failed:production-readiness-guard-missing\nC:\\runner\\private-path\\stack.js",
    });

    expect(diagnostic).toEqual({
      phase: "success",
      exitCode: 1,
      resultReportStatus: "missing",
      failureCode: "production-readiness-guard-missing",
      failureClass: "unclassified-process-output",
      phaseStage: null,
      outputLineCount: 2,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-path");
  });

  it("classifies a native module startup failure without including its path", () => {
    const diagnostic = summarizePackagedPhaseFailure({
      phase: "success",
      exitCode: 1,
      resultReportStatus: "missing",
      capturedOutput: "The specified module could not be found: C:\\runner\\SiteIndex\\native.node",
    });

    expect(diagnostic.failureClass).toBe("native-module-load");
    expect(JSON.stringify(diagnostic)).not.toContain("SiteIndex");
  });

  it("retains only the last allowlisted phase stage from process output", () => {
    const diagnostic = summarizePackagedPhaseFailure({
      phase: "success",
      exitCode: 0,
      resultReportStatus: "running",
      capturedOutput:
        "media-production:success:stage:renderer-ready\nmedia-production:success:stage:media-rows-ready\nmedia-production:success:stage:media-selection-ready\nmedia-production:success:stage:caught-error\nmedia-production:success:stage:report-written\nC:\\runner\\private-path",
    });

    expect(diagnostic.phaseStage).toBe("media-selection-ready");
    expect(JSON.stringify(diagnostic)).not.toContain("private-path");
  });
});

describe("packaged media phase process lifecycle", () => {
  function mockChildProcess() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  }

  function runWith(child: ReturnType<typeof mockChildProcess>, readReport: () => Promise<string>) {
    const diagnostics: unknown[] = [];
    const phase = runPackagedPhaseProcess({
      executable: "synthetic-siteindex.exe",
      env: {},
      phase: "success",
      reportPath: "synthetic-phase-report.json",
      spawnProcess: vi.fn(() => child),
      readReport,
      onFailureDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      timeoutMs: 60_000,
    });
    return { phase, diagnostics };
  }

  it("keeps spawn failure as the final diagnostic when close follows error", async () => {
    const child = mockChildProcess();
    const readReport = vi.fn(async () => '{"status":"passed","phase":"success"}');
    const { phase, diagnostics } = runWith(child, readReport);

    child.emit("error", new Error("synthetic spawn failure"));
    child.emit("close", -2);

    await expect(phase).rejects.toThrow("could not start");
    expect(readReport).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ failureCode: "child-spawn-failed", resultReportStatus: "missing" });
  });

  it.each([null, 0, "passed", []])("rejects a JSON report with invalid top-level shape: %s", async (report) => {
    const child = mockChildProcess();
    const { phase, diagnostics } = runWith(child, async () => JSON.stringify(report));
    child.emit("close", 0);

    await expect(phase).rejects.toThrow("invalid shape");
    expect(diagnostics[0]).toMatchObject({ resultReportStatus: "invalid-shape" });
  });

  it("fails closed for missing and invalid JSON reports", async () => {
    const missingChild = mockChildProcess();
    const missing = runWith(missingChild, async () => {
      throw new Error("synthetic missing report");
    });
    missingChild.emit("close", 0);
    await expect(missing.phase).rejects.toThrow("report missing");
    expect(missing.diagnostics[0]).toMatchObject({ resultReportStatus: "missing" });

    const invalidChild = mockChildProcess();
    const invalid = runWith(invalidChild, async () => "{");
    invalidChild.emit("close", 0);
    await expect(invalid.phase).rejects.toThrow("report invalid");
    expect(invalid.diagnostics[0]).toMatchObject({ resultReportStatus: "invalid-json" });
  });

  it("accepts only exit zero with a passed report for the requested phase", async () => {
    const child = mockChildProcess();
    const expected = { status: "passed", phase: "success" };
    const { phase } = runWith(child, async () => JSON.stringify(expected));
    child.emit("close", 0);

    await expect(phase).resolves.toEqual(expected);
  });
});
