function matchesVersion(actual, expected) {
  if (!actual) return false;
  const normalized = String(actual).replace(/^v/iu, "");
  return normalized === expected || normalized.startsWith(`${expected}.`);
}

export async function waitForUpdatedWindowsApp(options) {
  const deadline = options.now() + options.timeoutMs;
  let lastVersion = null;
  let lastError = null;
  let executableVersion = null;
  let updaterRestartDetected = false;

  while (options.now() < deadline) {
    try {
      const connected = await options.connectExisting();
      if (connected) {
        lastVersion = connected.version;
        if (connected.version === options.candidateVersion) {
          return {
            connected,
            updaterRestart: {
              detected: true,
              hadRemoteDebugPort: true,
              harnessRelaunchedForIpc: false,
              originalRestartProfile: "verified-by-candidate-ipc",
              harnessProfileVerified: false,
              executableVersion,
            },
          };
        }
      }
    } catch (error) {
      lastError = error;
    }

    executableVersion = await options.getInstalledExecutableVersion().catch(() => null);
    if (matchesVersion(executableVersion, options.candidateVersion)) {
      if (await options.isOriginalProcessRunning()) {
        await options.wait(options.intervalMs);
        continue;
      }

      updaterRestartDetected ||= (await options.getInstalledProcessCount()) > 0;
      if (updaterRestartDetected) {
        await options.stopInstalledProcesses();
        const reopened = await options.launchForVerification();
        lastVersion = reopened.version;
        if (reopened.version !== options.candidateVersion) {
          throw new Error(`Reopened candidate app reports ${reopened.version}; expected ${options.candidateVersion}.`);
        }
        return {
          connected: reopened,
          updaterRestart: {
            detected: true,
            hadRemoteDebugPort: false,
            harnessRelaunchedForIpc: true,
            originalRestartProfile: "unknown",
            harnessProfileVerified: false,
            executableVersion,
          },
        };
      }
    }
    await options.wait(options.intervalMs);
  }

  const detail = lastVersion
    ? `latest observed version ${lastVersion}`
    : lastError
      ? options.formatError(lastError)
      : "no app window observed";
  throw new Error(
    `GitHub hosted update did not relaunch v${options.candidateVersion} within the acceptance timeout (${detail}).`,
  );
}
