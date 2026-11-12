const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
]);

const REQUIRED_RESTART_STAGES = Object.freeze([
  "credential-projects-registered",
  "both-sites-configured",
  "site-b-replaced",
  "site-b-deleted",
]);

const REQUIRED_SITE_STATES = Object.freeze([
  ["A", "assert-status", "not_configured"],
  ["B", "assert-status", "not_configured"],
  ["A", "configure", "configured"],
  ["B", "configure", "configured"],
  ["B", "replace", "configured"],
  ["A", "replace", "configured"],
  ["B", "delete", "not_configured"],
  ["A", "delete", "configured"],
  ["A", "delete", "not_configured"],
]);

const REQUIRED_PROFILE_FLAGS = Object.freeze([
  "shellAppDataRedirected",
  "shellAppDataRestored",
  "nativeAppDataMatchesProfile",
  "projectRootContained",
  "vaultContained",
  "processExecutableContained",
  "installDirectoryContained",
  "installerExeInRoot",
  "junctionEscapeRejected",
  "junctionCleanupVerified",
]);

function isContained(check) {
  return check?.withinRoot === true && check?.noReparse === true;
}

function hasState(states, [alias, stage, state]) {
  return states.some((entry) => entry?.alias === alias && entry?.stage === stage && entry?.state === state);
}

/**
 * Evaluate only the redacted credential-isolation summary emitted by the
 * Windows packaged acceptance harness. The returned object never contains
 * input paths, raw report values, or canary values.
 */
export function evaluateCredentialIsolationReport(report, canaryValues = []) {
  const failures = new Set();
  const result = report?.credentialIsolation;

  if (!result || typeof result !== "object") {
    return { passed: false, failureCodes: ["CREDENTIAL_REPORT_MISSING"] };
  }

  const environmentPaths = result.environmentPaths;
  for (const key of REQUIRED_ENVIRONMENT_KEYS) {
    if (!isContained(environmentPaths?.[key])) failures.add("ENVIRONMENT_PATH_NOT_CONTAINED");
  }

  for (const key of ["subprocessPathDiagnostics", "preloadPathDiagnostics"]) {
    const diagnostic = result[key];
    if (diagnostic?.observed !== true || diagnostic?.contained !== true || diagnostic?.pathCount !== 10) {
      failures.add("RUNTIME_PATH_OBSERVATION_INCOMPLETE");
    }
  }

  for (const key of REQUIRED_PROFILE_FLAGS) {
    if (result[key] !== true) failures.add("ISOLATION_OR_CLEANUP_CHECK_FAILED");
  }

  const restarts = Array.isArray(result.restarts) ? result.restarts : [];
  for (const stage of REQUIRED_RESTART_STAGES) {
    const restart = restarts.find((entry) => entry?.stage === stage);
    if (restart?.previousProcessStopped !== true || restart?.processDistinct !== true || restart?.rendererDistinct !== true) {
      failures.add("RESTART_EVIDENCE_INCOMPLETE");
    }
  }

  const states = Array.isArray(result.siteStates) ? result.siteStates : [];
  if (REQUIRED_SITE_STATES.some((expected) => !hasState(states, expected))) {
    failures.add("CREDENTIAL_STATE_READBACK_INCOMPLETE");
  }

  const ipcCounts = result.ipcCounts;
  if (!(ipcCounts?.status > 0 && ipcCounts?.save >= 3 && ipcCounts?.clear >= 2)) {
    failures.add("CREDENTIAL_IPC_EVIDENCE_INCOMPLETE");
  }

  const canary = result.canary;
  const diskScan = canary?.diskScan;
  if (canary?.echoedCount !== 0 || canary?.browserStorageMatchCount !== 0
    || canary?.diskMatchedFileCount !== 0
    || diskScan?.profileScanCompleted !== true
    || diskScan?.outputArtifactScanCompleted !== true
    || !(diskScan?.filesScanned > 0)
    || diskScan?.matchingFileCount !== 0
    || !diskScan?.matchCounts
    || Object.values(diskScan.matchCounts).some((count) => count !== 0)) {
    failures.add("CREDENTIAL_LEAK_SCAN_FAILED_OR_INCOMPLETE");
  }

  let serializedReport = "";
  try {
    serializedReport = JSON.stringify(report) ?? "";
  } catch {
    failures.add("CREDENTIAL_REPORT_NOT_SERIALIZABLE");
  }
  if (canaryValues.some((value) => typeof value === "string" && value.length > 0 && serializedReport.includes(value))) {
    failures.add("CANARY_VALUE_IN_REPORT");
  }

  return { passed: failures.size === 0, failureCodes: [...failures].sort() };
}
