const PROCESS_ROLES = new Set(["candidate-installer", "installed-app", "uninstaller"]);
const OUTCOMES = new Set(["observing", "completed", "timeout", "failed"]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/u;
const MAX_OBSERVATIONS = 48;

function normalizedVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

function normalizedTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function normalizedProcess(value) {
  if (!value || typeof value !== "object" || !PROCESS_ROLES.has(value.role)) return null;
  const pid = normalizedPid(value.pid);
  if (!pid) return null;
  return {
    role: value.role,
    pid,
    parentPid: normalizedPid(value.parentPid),
    startedAt: normalizedTimestamp(value.startedAt),
    responding: typeof value.responding === "boolean" ? value.responding : null,
    hasWindow: typeof value.hasWindow === "boolean" ? value.hasWindow : null,
  };
}

function normalizedOriginalProcess(value) {
  if (!value || typeof value !== "object") return { pid: null, alive: null, exitCode: null };
  const exitCode = Number.isInteger(value.exitCode) ? value.exitCode : null;
  return {
    pid: normalizedPid(value.pid),
    alive: typeof value.alive === "boolean" ? value.alive : null,
    exitCode,
  };
}

export function createHostedUpdateDiagnostics({
  baselineVersion,
  candidateVersion,
  baselineExecutableVersion,
  startedAt = new Date(),
}) {
  const startTime = normalizedTimestamp(startedAt) ?? new Date().toISOString();
  const installerProcesses = new Map();
  const observations = [];
  let outcome = "observing";
  let failureCode = null;
  let finishedAt = null;
  let latestInstalledExecutableVersion = normalizedVersion(baselineExecutableVersion);
  let latestOriginalProcess = normalizedOriginalProcess(null);

  return {
    record(value = {}) {
      const observedAt = normalizedTimestamp(value.observedAt) ?? new Date().toISOString();
      const processes = (Array.isArray(value.processes) ? value.processes : []).map(normalizedProcess).filter(Boolean);
      const installedExecutableVersion = normalizedVersion(value.installedExecutableVersion);
      if (installedExecutableVersion) latestInstalledExecutableVersion = installedExecutableVersion;
      latestOriginalProcess = normalizedOriginalProcess(value.originalProcess);

      if (value.processSnapshotAvailable === true) {
        for (const installer of installerProcesses.values()) {
          installer.aliveAtLastProcessSnapshot = false;
          installer.lastProcessSnapshotAt = observedAt;
        }
        for (const process of processes) {
          if (process.role !== "candidate-installer") continue;
          const key = `${process.pid}:${process.startedAt ?? "unknown"}`;
          const previous = installerProcesses.get(key);
          installerProcesses.set(key, {
            pid: process.pid,
            firstSeenAt: previous?.firstSeenAt ?? observedAt,
            lastSeenAt: observedAt,
            lastProcessSnapshotAt: observedAt,
            aliveAtLastProcessSnapshot: true,
            exitCode: null,
          });
        }
      }

      observations.push({
        observedAt,
        installedExecutableVersion,
        processSnapshotAvailable: value.processSnapshotAvailable === true,
        processes,
        originalProcess: latestOriginalProcess,
        cdp: {
          reachable: value.cdp?.reachable === true,
          targetCount:
            Number.isSafeInteger(value.cdp?.targetCount) && value.cdp.targetCount >= 0 ? value.cdp.targetCount : null,
        },
      });
      if (observations.length > MAX_OBSERVATIONS) observations.shift();
    },
    finish(nextOutcome, nextFailureCode = null, at = new Date()) {
      outcome = OUTCOMES.has(nextOutcome) ? nextOutcome : "failed";
      failureCode =
        outcome === "timeout"
          ? "UPDATE_RELAUNCH_TIMEOUT"
          : outcome === "failed" && nextFailureCode === "UPDATE_FLOW_FAILED"
            ? "UPDATE_FLOW_FAILED"
            : null;
      finishedAt = normalizedTimestamp(at) ?? new Date().toISOString();
    },
    toJSON() {
      return {
        schemaVersion: 1,
        outcome,
        failureCode,
        baselineVersion: normalizedVersion(baselineVersion),
        candidateVersion: normalizedVersion(candidateVersion),
        startedAt: startTime,
        finishedAt,
        baselineExecutableVersion: normalizedVersion(baselineExecutableVersion),
        latestInstalledExecutableVersion,
        originalProcess: latestOriginalProcess,
        candidateInstallerProcesses: [...installerProcesses.values()].map((installer) => ({
          ...installer,
        })),
        observationCount: observations.length,
        observations: observations.map((observation) => ({
          ...observation,
          processes: observation.processes.map((process) => ({ ...process })),
          originalProcess: { ...observation.originalProcess },
          cdp: { ...observation.cdp },
        })),
      };
    },
  };
}
