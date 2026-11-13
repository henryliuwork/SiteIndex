import { describe, expect, it } from "vitest";
import { createHostedUpdateDiagnostics } from "../scripts/e-windows-v041-updater-diagnostics.mjs";

describe("hosted updater timeout diagnostics", () => {
  it("keeps installer PID liveness and installed versions without serializing sensitive fields", () => {
    const diagnostics = createHostedUpdateDiagnostics({
      baselineVersion: "0.4.0",
      candidateVersion: "0.4.1",
      baselineExecutableVersion: "0.4.0.0",
      startedAt: "2026-11-13T03:40:00.000Z",
    });
    diagnostics.record({
      observedAt: "2026-11-13T03:40:05.000Z",
      installedExecutableVersion: "0.4.0.0",
      processSnapshotAvailable: true,
      processes: [
        {
          role: "candidate-installer",
          pid: 7556,
          parentPid: 5100,
          startedAt: "2026-11-13T03:40:04.000Z",
          responding: true,
          hasWindow: false,
          executablePath: "C:\\private\\SiteIndex-Setup.exe",
          commandLine: "<sensitive command line>",
        },
      ],
      originalProcess: { pid: 7020, alive: false, exitCode: 0 },
      cdp: { reachable: false, targetCount: null, url: "http://127.0.0.1:9333/json/list" },
    });
    diagnostics.record({
      observedAt: "2026-11-13T03:40:10.000Z",
      installedExecutableVersion: "0.4.1.0",
      processSnapshotAvailable: true,
      processes: [{ role: "installed-app", pid: 8111, responding: true, hasWindow: true }],
      originalProcess: { pid: 7020, alive: false, exitCode: 0 },
      cdp: { reachable: true, targetCount: 1 },
    });
    diagnostics.finish("timeout", null, "2026-11-13T03:43:10.000Z");

    const json = diagnostics.toJSON();
    expect(json).toMatchObject({
      outcome: "timeout",
      failureCode: "UPDATE_RELAUNCH_TIMEOUT",
      baselineExecutableVersion: "0.4.0.0",
      latestInstalledExecutableVersion: "0.4.1.0",
      originalProcess: { pid: 7020, alive: false, exitCode: 0 },
      candidateInstallerProcesses: [
        {
          pid: 7556,
          aliveAtLastProcessSnapshot: false,
          lastProcessSnapshotAt: "2026-11-13T03:40:10.000Z",
          exitCode: null,
        },
      ],
      observationCount: 2,
    });
    expect(JSON.stringify(json)).not.toContain("private");
    expect(JSON.stringify(json)).not.toContain("commandLine");
    expect(JSON.stringify(json)).not.toContain("sensitive");
    expect(JSON.stringify(json)).not.toContain("url");
  });

  it("rejects arbitrary process roles and malformed versions from snapshots", () => {
    const diagnostics = createHostedUpdateDiagnostics({
      baselineVersion: "C:\\private\\baseline.exe",
      candidateVersion: "0.4.1",
      baselineExecutableVersion: null,
    });
    diagnostics.record({
      observedAt: "2026-11-13T03:40:05.000Z",
      installedExecutableVersion: "<private path>",
      processSnapshotAvailable: true,
      processes: [
        { role: "unknown", pid: 1, name: "sensitive process name" },
        { role: "candidate-installer", pid: 0 },
      ],
      originalProcess: { pid: 2, alive: true, exitCode: null },
      cdp: { reachable: false, targetCount: -1 },
    });
    diagnostics.finish("failed", "UNEXPECTED_RAW_ERROR");

    expect(diagnostics.toJSON()).toMatchObject({
      outcome: "failed",
      failureCode: null,
      baselineVersion: null,
      candidateVersion: "0.4.1",
      latestInstalledExecutableVersion: null,
      candidateInstallerProcesses: [],
      observations: [{ processes: [], cdp: { reachable: false, targetCount: null } }],
    });
    expect(JSON.stringify(diagnostics.toJSON())).not.toContain("private");
    expect(JSON.stringify(diagnostics.toJSON())).not.toContain("sensitive");
    expect(JSON.stringify(diagnostics.toJSON())).not.toContain("UNEXPECTED_RAW_ERROR");
  });

  it("does not infer that an installer exited when the latest process sample was unavailable", () => {
    const diagnostics = createHostedUpdateDiagnostics({ baselineVersion: "0.4.0", candidateVersion: "0.4.1" });
    diagnostics.record({
      observedAt: "2026-11-13T03:40:05.000Z",
      processSnapshotAvailable: true,
      processes: [{ role: "candidate-installer", pid: 7556, startedAt: "2026-11-13T03:40:04.000Z" }],
    });
    diagnostics.record({
      observedAt: "2026-11-13T03:40:10.000Z",
      processSnapshotAvailable: false,
      processes: [],
    });

    expect(diagnostics.toJSON().candidateInstallerProcesses).toEqual([
      expect.objectContaining({
        pid: 7556,
        aliveAtLastProcessSnapshot: true,
        lastProcessSnapshotAt: "2026-11-13T03:40:05.000Z",
        exitCode: null,
      }),
    ]);
  });
});
