import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateCredentialIsolationReport } from "./credential-isolation-report-oracle.mjs";

const ENVIRONMENT_KEYS = ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"];
const PATH_CHECK = { withinRoot: true, noReparse: true };
const SYNTHETIC_CANARIES = ["fixture-user-canary", "fixture-password-canary", "Basic Zml4dHVyZS1jYW5hcnk="];

function passingReport() {
  return {
    credentialIsolation: {
      environmentPaths: Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, { ...PATH_CHECK }])),
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
      restarts: [
        "credential-projects-registered",
        "both-sites-configured",
        "site-b-replaced",
        "site-b-deleted",
      ].map((stage) => ({ stage, previousProcessStopped: true, processDistinct: true, rendererDistinct: true })),
      siteStates: [
        { alias: "A", stage: "assert-status", state: "not_configured" },
        { alias: "B", stage: "assert-status", state: "not_configured" },
        { alias: "A", stage: "configure", state: "configured" },
        { alias: "B", stage: "configure", state: "configured" },
        { alias: "B", stage: "replace", state: "configured" },
        { alias: "A", stage: "replace", state: "configured" },
        { alias: "B", stage: "delete", state: "not_configured" },
        { alias: "A", stage: "delete", state: "configured" },
        { alias: "A", stage: "delete", state: "not_configured" },
      ],
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

describe("v0.4.1 credential-isolation acceptance report oracle", () => {
  it("accepts a complete synthetic packaged-run summary without path or credential values", () => {
    const result = evaluateCredentialIsolationReport(passingReport(), SYNTHETIC_CANARIES);
    assert.deepEqual(result, { passed: true, failureCodes: [] });
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_CANARIES[0]), false);
  });

  it("rejects missing environment observations and any resolved reparse path", () => {
    const report = passingReport();
    delete report.credentialIsolation.environmentPaths.APPDATA;
    report.credentialIsolation.environmentPaths.TEMP = { withinRoot: true, noReparse: false };
    report.credentialIsolation.preloadPathDiagnostics.pathCount = 9;

    const result = evaluateCredentialIsolationReport(report, SYNTHETIC_CANARIES);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failureCodes, ["ENVIRONMENT_PATH_NOT_CONTAINED", "RUNTIME_PATH_OBSERVATION_INCOMPLETE"]);
  });

  it("requires the synthetic project and vault roots plus the reparse escape probe to remain contained", () => {
    const report = passingReport();
    report.credentialIsolation.projectRootContained = false;
    report.credentialIsolation.vaultContained = false;
    report.credentialIsolation.junctionEscapeRejected = false;

    const result = evaluateCredentialIsolationReport(report, SYNTHETIC_CANARIES);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failureCodes, ["ISOLATION_OR_CLEANUP_CHECK_FAILED"]);
  });

  it("rejects incomplete restarts and missing cross-origin state readbacks", () => {
    const report = passingReport();
    report.credentialIsolation.restarts[1].rendererDistinct = false;
    report.credentialIsolation.siteStates = report.credentialIsolation.siteStates.filter(
      ({ alias, stage }) => !(alias === "A" && stage === "delete"),
    );

    const result = evaluateCredentialIsolationReport(report, SYNTHETIC_CANARIES);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failureCodes, ["CREDENTIAL_STATE_READBACK_INCOMPLETE", "RESTART_EVIDENCE_INCOMPLETE"]);
  });

  it("rejects canary text in a report and an incomplete disk scan without echoing values", () => {
    const report = passingReport();
    report.processOutput[0].text = `diagnostic ${SYNTHETIC_CANARIES[1]}`;
    report.credentialIsolation.canary.diskScan.outputArtifactScanCompleted = false;

    const result = evaluateCredentialIsolationReport(report, SYNTHETIC_CANARIES);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failureCodes, ["CANARY_VALUE_IN_REPORT", "CREDENTIAL_LEAK_SCAN_FAILED_OR_INCOMPLETE"]);
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_CANARIES[1]), false);
  });
});
