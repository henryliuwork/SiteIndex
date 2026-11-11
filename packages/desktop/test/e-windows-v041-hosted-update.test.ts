import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeW2SyntheticFixture } from "../scripts/e-windows-v040-synthetic-fixture.mjs";
import { waitForUpdatedWindowsApp } from "../scripts/e-windows-v041-reconnect.mjs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/e-windows-v040-acceptance.yml", import.meta.url),
  "utf8",
);
const releaseWorkflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
const acceptanceScript = readFileSync(new URL("../scripts/e-windows-v040-acceptance.mjs", import.meta.url), "utf8");
const profileIsolation = readFileSync(new URL("../scripts/e-windows-profile-isolation.mjs", import.meta.url), "utf8");

describe("Windows v0.4.0 to v0.4.1 hosted upgrade acceptance", () => {
  it("pins the verified v0.4.0 tag, asset, and installer digest as the baseline", () => {
    expect(workflow).toContain('default: "0.4.0"');
    expect(workflow).toContain('default: "334d5bee76156ad856986031020f51b2bcb7319d"');
    expect(workflow).toContain('default: "734250277"');
    expect(workflow).toContain('default: "a7414e062a18170ef00f3bb7e09d11cb2b81d2197baff8717b7ee4a9ddda2b90"');
    expect(workflow).toContain("$tagObject.sha -cne $expectedCommit");
    expect(workflow).toContain("$asset.id -ne $expectedAssetId");
    expect(workflow).toContain("$actual -cne $expectedDigest");
  });

  it("requires a newer published candidate pinned to its tag commit, Release asset, and digest", () => {
    expect(workflow).toContain('default: "0.4.1"');
    expect(workflow).toContain("hosted_update:");
    expect(workflow).toContain("candidate_release_commit:");
    expect(workflow).toContain("candidate_release_asset_id:");
    expect(workflow).toContain("candidate_release_asset_sha256:");
    expect(workflow).toContain("$latest.tag_name -cne $tag");
    expect(workflow).toContain("Candidate version tag does not resolve to the supplied source commit.");
    expect(workflow).toContain('$_.name -ceq "package (windows-latest, win)"');
    expect(workflow).toContain('$_.name -ceq "verify-release-assets"');
    expect(workflow).toContain("actions/runs/$($releaseRun[0].id)/artifacts");
    expect(workflow).toContain("actions/download-artifact@v8");
    expect(workflow).toContain("digest-mismatch: error");
    expect(workflow).toContain('Where-Object { $_.name -ceq "latest.yml" }');
    expect(workflow).toContain('$feedText -notmatch "(?m)^version:');
    expect(workflow).toContain('$feedText -notmatch "(?m)^\\s*url:');
    expect(workflow).toContain("$actualSha512 -cne $feedSha512Match.Groups[1].Value");
    expect(acceptanceScript).toContain("candidateReleaseCommit === report.candidateSourceCommit");
    expect(acceptanceScript).toContain("report.candidateReleaseAssetSha256 === report.candidateInstallerSha256");
    expect(acceptanceScript).toContain("report.candidateReleaseArtifactExeSha256 === report.candidateInstallerSha256");
    expect(acceptanceScript).toContain("OLD_RELEASE.version");
    expect(acceptanceScript).toContain("report.updaterRestart");
    expect(acceptanceScript).toContain("ephemeral GitHub runner APPDATA with a clean per-run SiteIndex directory");
    expect(acceptanceScript).toContain("isolated temporary LOCALAPPDATA vault");
    expect(releaseWorkflow).toContain("retention-days: 30");
  });

  it("drives the packaged update API and checks the re-launched app version", () => {
    expect(acceptanceScript).toContain("updates.check()");
    expect(acceptanceScript).toContain("await updates.download()");
    expect(acceptanceScript).toContain("updates.install().catch");
    expect(acceptanceScript).toContain("candidateState.version === CANDIDATE_VERSION");
    expect(acceptanceScript).toContain("oldState.version === OLD_RELEASE.version");
    expect(readFileSync(new URL("../scripts/e-windows-v041-reconnect.mjs", import.meta.url), "utf8")).toContain(
      "reopened.version !== options.candidateVersion",
    );
  });

  it("uses only reserved synthetic fixture domains", () => {
    const serialized = JSON.stringify(makeW2SyntheticFixture("https://synthetic.example.invalid"));
    const urls = serialized.match(/https?:\/\/[^\\"\s]+/gu) ?? [];

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((value) => new URL(value).hostname.endsWith(".invalid"))).toBe(true);
  });

  it("isolates roaming and machine-local data for the installed application", () => {
    expect(acceptanceScript).toContain("const PROFILE_LAYOUT = createWindowsProfileLayout(TEST_ROOT)");
    expect(acceptanceScript).toContain("const APP_DATA_ROOT = PROFILE_LAYOUT.appDataRoot");
    expect(acceptanceScript).toContain("windowsProfileEnvironment(PROFILE_LAYOUT, process.env)");
    expect(acceptanceScript).not.toContain("APP_DATA_ROOT = process.env.APPDATA");
    expect(acceptanceScript).not.toContain('LOCAL_APP_DATA_ROOT = path.join(TEST_ROOT, "local-app-data")');
    for (const key of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"]) {
      expect(profileIsolation).toContain(`"${key}"`);
    }
    expect(profileIsolation).toContain("inspectWindowsProfileLayout");
    expect(acceptanceScript).toContain("await prepareIsolatedProfile()");
    expect(acceptanceScript).toContain("report.credentialIsolation.junctionEscapeRejected");
    expect(acceptanceScript).toContain("installerExeInRoot");
    expect(acceptanceScript).toContain("const RUNNER_TEMP = process.env.RUNNER_TEMP");
    expect(acceptanceScript).toContain('mkdtemp(path.join(RUNNER_TEMP, "siteindex-e-acceptance-"))');
    expect(acceptanceScript).toContain("report.credentialIsolation.processExecutableContained");
    expect(acceptanceScript).toContain("await verifyElectronProfileDiagnostics(page)");
    expect(acceptanceScript).toContain("window.siteindexWindow");
    expect(acceptanceScript).toContain("verifyProfile: false");
    expect(acceptanceScript).toContain("await scanCredentialCanaries()");
    expect(acceptanceScript).toContain("matchingFileCount");
    expect(acceptanceScript).toContain('Buffer.from(value, "utf8").toString("base64")');
    expect(acceptanceScript).toContain("plaintextUtf16le");
    expect(acceptanceScript).toContain("base64Utf16le");
    expect(acceptanceScript).toContain("basicHeader");
    expect(acceptanceScript).toContain("outputArtifact");
    expect(acceptanceScript).toContain("await removeIsolatedTestRoot()");
    expect(acceptanceScript).toContain("report.credentialIsolation.junctionCleanupVerified");
    expect(acceptanceScript).toContain(
      "Refusing recursive cleanup because the test root is no longer contained in RUNNER_TEMP.",
    );
    expect(acceptanceScript).toContain("<FILE_URL>");
    expect(acceptanceScript).toContain("<CREDENTIAL>");
    expect(workflow).toContain("path: siteindex-e-windows-results/");
    expect(workflow).not.toContain("SITEINDEX_BASE_INSTALLER_PATH=");
    expect(workflow).not.toContain("SITEINDEX_CANDIDATE_INSTALLER_PATH=");
    expect(workflow).not.toContain("SITEINDEX_ACCEPTANCE_OUTPUT=$(Join-Path");
    expect(acceptanceScript).toContain('process.env.GITHUB_ACTIONS !== "true"');
    expect(acceptanceScript).toContain("before its UI target appeared");
    expect(acceptanceScript).toContain("rendererDiagnostics.targets");
  });

  it("sets and verifies the actual packaged Electron profile before touching app data", () => {
    const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../src/preload/window-api.ts", import.meta.url), "utf8");
    const diagnostic = readFileSync(new URL("../src/main/profile-path-diagnostic.ts", import.meta.url), "utf8");

    expect(main).toContain('app.setPath("appData", appDataPath)');
    expect(main).toContain('app.setPath("userData", join(appDataPath, "SiteIndex"))');
    expect(main).toContain("SITEINDEX_PROFILE_PATHS");
    expect(main).toContain("JSON.stringify(profilePaths)");
    expect(main.indexOf("profilePathsAreContained(profilePaths)")).toBeLessThan(
      main.indexOf('createSettingsStore(join(app.getPath("appData"), "SiteIndex"))'),
    );
    expect(preload).toContain("si:desktop.profilePathDiagnostics");
    expect(diagnostic).toContain("realpath");
    expect(diagnostic).toContain("noReparse");
    expect(diagnostic).not.toContain("console.");
  });

  it("runs two-site credential isolation through the packaged UI and reports only aliases, states, method counts and canary counts", () => {
    expect(acceptanceScript).toContain(
      'import { runWordPressCredentialsUiSmoke } from "../../ui/visual/wordpress-credentials-smoke.mjs"',
    );
    expect(acceptanceScript).toContain('CREDENTIAL_SITE_A_ORIGIN = "https://site-a.synthetic.invalid"');
    expect(acceptanceScript).toContain('CREDENTIAL_SITE_B_ORIGIN = "https://site-b.synthetic.invalid"');
    expect(acceptanceScript).toContain('phase: "configure"');
    expect(acceptanceScript).toContain('phase: "replace"');
    expect(acceptanceScript).toContain('phase: "delete"');
    expect(acceptanceScript).toContain('restartCandidateWithSameProfile(page, "both-sites-configured")');
    expect(acceptanceScript).toContain('restartCandidateWithSameProfile(page, "site-b-replaced")');
    expect(acceptanceScript).toContain('restartCandidateWithSameProfile(page, "site-b-deleted")');
    expect(acceptanceScript).toContain("ipcCounts: { status: 0, save: 0, clear: 0 }");
    expect(acceptanceScript).toContain('canary: {\n      type: "synthetic username and application password",');
    expect(acceptanceScript).toContain("credentialIsolation.siteStates.push({ alias, stage: phase, state })");
    expect(acceptanceScript).not.toContain("credentialIsolation.siteStates.push({ alias, origin");
  });

  it("copies both installers under the isolated root and sanitizes synthetic credential markers in diagnostics", () => {
    expect(acceptanceScript).toContain("copyFile(oldInstallerSource, oldInstaller)");
    expect(acceptanceScript).toContain("copyFile(candidateInstallerSource, candidateInstaller)");
    expect(acceptanceScript).toContain("inspectContainedPath(TEST_ROOT, oldInstaller)");
    expect(acceptanceScript).toContain("inspectContainedPath(TEST_ROOT, candidateInstaller)");
    expect(acceptanceScript).toContain("page = await testWordPressCredentialIsolation(page)");
    expect(acceptanceScript).toContain('safe = safe.replaceAll(variant, "<CREDENTIAL>")');
    expect(acceptanceScript).toContain("env: isolatedProcessEnvironment() });");
  });

  it("checks the installed version and updater process without a CDP endpoint, then reopens under the isolated profile", async () => {
    let now = 100;
    const calls: string[] = [];
    const result = await waitForUpdatedWindowsApp({
      candidateVersion: "0.4.1",
      connectExisting: async () => {
        calls.push("cdp");
        return null;
      },
      getInstalledExecutableVersion: async () => {
        calls.push("exe-version");
        return "0.4.1.0";
      },
      isOriginalProcessRunning: async () => {
        calls.push("old-process-exited");
        return false;
      },
      getInstalledProcessCount: async () => {
        calls.push("installed-process-count");
        return 1;
      },
      stopInstalledProcesses: async () => {
        calls.push("stop-installed-process");
      },
      launchForVerification: async () => {
        calls.push("launch-isolated-harness");
        return { page: "candidate-page", version: "0.4.1" };
      },
      now: () => now,
      wait: async (milliseconds: number) => {
        now += milliseconds;
      },
      intervalMs: 1,
      timeoutMs: 10,
      formatError: (error: unknown) => String(error),
    });

    expect(calls).toEqual([
      "cdp",
      "exe-version",
      "old-process-exited",
      "installed-process-count",
      "stop-installed-process",
      "launch-isolated-harness",
    ]);
    expect(result).toMatchObject({
      connected: { page: "candidate-page", version: "0.4.1" },
      updaterRestart: {
        detected: true,
        hadRemoteDebugPort: false,
        harnessRelaunchedForIpc: true,
        originalRestartProfile: "unknown",
        harnessProfileVerified: false,
        executableVersion: "0.4.1.0",
      },
    });
  });

  it("requires a disposable GitHub runner and the isolated profile before installing", () => {
    expect(acceptanceScript).toContain('process.env.GITHUB_ACTIONS !== "true"');
    expect(acceptanceScript).toContain('process.env.SITEINDEX_RUNNER_ENVIRONMENT !== "github-hosted"');
    expect(workflow).toContain("SITEINDEX_RUNNER_ENVIRONMENT: ${{ runner.environment }}");
    expect(acceptanceScript).toContain(
      "Packaged acceptance must run on a GitHub-hosted Actions Windows runner to isolate the complete process profile safely",
    );
    expect(acceptanceScript).toContain("await prepareIsolatedProfile()");
    expect(acceptanceScript).toContain("const before = await inspectContainedPath(RUNNER_TEMP, TEST_ROOT)");
    expect(acceptanceScript).toContain("await rm(TEST_ROOT, { recursive: true, force: true");
    expect(acceptanceScript).not.toContain("await rm(APP_DATA_DIR, { recursive: true, force: true");
    expect(acceptanceScript).toContain(
      'if (await exists(TEST_ROOT)) throw new Error("The isolated test root remains after cleanup.")',
    );
  });

  it("does not claim an update until the updater has restarted the candidate", async () => {
    let now = 0;
    const launchForVerification = vi.fn();
    await expect(
      waitForUpdatedWindowsApp({
        candidateVersion: "0.4.1",
        connectExisting: async () => null,
        getInstalledExecutableVersion: async () => "0.4.0.0",
        isOriginalProcessRunning: async () => false,
        getInstalledProcessCount: async () => 0,
        stopInstalledProcesses: async () => undefined,
        launchForVerification,
        now: () => now,
        wait: async (milliseconds: number) => {
          now += milliseconds;
        },
        intervalMs: 1,
        timeoutMs: 3,
        formatError: (error: unknown) => String(error),
      }),
    ).rejects.toThrow("did not relaunch v0.4.1");
    expect(launchForVerification).not.toHaveBeenCalled();
  });

  it("accepts the original updater restart when its CDP endpoint is available", async () => {
    const getInstalledExecutableVersion = vi.fn();
    const result = await waitForUpdatedWindowsApp({
      candidateVersion: "0.4.1",
      connectExisting: async () => ({ page: "native-updater-page", version: "0.4.1" }),
      getInstalledExecutableVersion,
      isOriginalProcessRunning: async () => false,
      getInstalledProcessCount: async () => 0,
      stopInstalledProcesses: async () => undefined,
      launchForVerification: async () => ({ page: "harness-page", version: "0.4.1" }),
      now: () => 0,
      wait: async () => undefined,
      intervalMs: 1,
      timeoutMs: 10,
      formatError: (error: unknown) => String(error),
    });
    expect(result.connected.page).toBe("native-updater-page");
    expect(result.updaterRestart.originalRestartProfile).toBe("verified-by-candidate-ipc");
    expect(getInstalledExecutableVersion).not.toHaveBeenCalled();
  });
});
