import { describe, expect, it } from "vitest";
import { attachCredentialIsolationOracle } from "../scripts/e-windows-v041-credential-oracle.mjs";

const containment = { withinRoot: true, noReparse: true };
const environmentKeys = ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"];
const restartStages = ["credential-projects-registered", "both-sites-configured", "site-b-replaced", "site-b-deleted"];
const expectedSiteStates = [
  ["A", "assert-status", "not_configured"],
  ["B", "assert-status", "not_configured"],
  ["A", "configure", "configured"],
  ["B", "configure", "configured"],
  ["B", "replace", "configured"],
  ["A", "replace", "configured"],
  ["B", "delete", "not_configured"],
  ["A", "delete", "configured"],
  ["A", "delete", "not_configured"],
];

function completeSyntheticReport() {
  return {
    checks: [],
    credentialIsolation: {
      environmentPaths: Object.fromEntries(environmentKeys.map((key) => [key, containment])),
      subprocessPathDiagnostics: { observed: true, contained: true, pathCount: 10 },
      preloadPathDiagnostics: { observed: true, contained: true, pathCount: 10 },
      shellAppDataRedirected: true,
      shellAppDataRestored: true,
      nativeAppDataMatchesProfile: true,
      projectRootContained: true,
      vaultContained: true,
      processExecutableContained: true,
      installDirectoryContained: true,
      installerExeInRoot: true,
      junctionEscapeRejected: true,
      junctionCleanupVerified: true,
      restarts: restartStages.map((stage) => ({ stage, previousProcessStopped: true, processDistinct: true, rendererDistinct: true })),
      siteStates: expectedSiteStates.map(([alias, stage, state]) => ({ alias, stage, state })),
      ipcCounts: { status: 8, save: 3, clear: 2 },
      canary: {
        echoedCount: 0,
        browserStorageMatchCount: 0,
        diskMatchedFileCount: 0,
        diskScan: {
          profileScanCompleted: true,
          outputArtifactScanCompleted: true,
          filesScanned: 12,
          matchingFileCount: 0,
          matchCounts: {
            plaintextUtf8: 0,
            plaintextUtf16le: 0,
            base64Utf8: 0,
            base64Utf16le: 0,
            basicHeader: 0,
          },
        },
      },
    },
    processOutput: [{ stream: "stderr", text: "synthetic packaged app started" }],
  };
}

describe("E #461 hosted credential isolation oracle integration", () => {
  it("adds a redacted passing oracle result to the candidate summary", () => {
    const report = completeSyntheticReport();
    const result = attachCredentialIsolationOracle(report);

    expect(result).toEqual({ passed: true, failureCodes: [] });
    expect(report.credentialIsolationOracle).toEqual(result);
    expect(report.checks.at(-1)).toEqual({
      name: "E #461 credential isolation report oracle",
      status: "passed",
      evidence: { failureCodes: [] },
    });
  });

  it("fails closed and reports only fixed failure codes when the hosted summary is incomplete", () => {
    const report = { checks: [], credentialIsolation: {} };
    const canary = "synthetic-secret-canary";
    const result = attachCredentialIsolationOracle(report, [canary]);

    expect(result.passed).toBe(false);
    expect(result.failureCodes).toContain("ENVIRONMENT_PATH_NOT_CONTAINED");
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(report.credentialIsolationOracle).toEqual(result);
    expect(report.checks.at(-1)?.status).toBe("failed");
  });
});
