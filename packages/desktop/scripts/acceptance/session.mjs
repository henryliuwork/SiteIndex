import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createWindowsAppDataRedirect } from "../windows-appdata-redirect.mjs";
import { createWindowsProfileLayout, windowsProfileEnvironment } from "../e-windows-profile-isolation.mjs";

const SENSITIVE_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"];

export async function waitForObserved(observe, { timeoutMs = 30_000, intervalMs = 200, label = "state" } = {}) {
  const until = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const value = await observe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= until) break;
    await pause(Math.min(intervalMs, until - Date.now()));
  } while (true);
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export function isolatedEnvironment(profile, base = process.env) {
  const env = { ...windowsProfileEnvironment(profile.layout, base),
    SITEINDEX_ACCEPTANCE_PROFILE_ROOT: profile.root,
    ELECTRON_RENDERER_URL: "", SITEINDEX_UI_URL: "" };
  for (const key of SENSITIVE_ENV) delete env[key];
  return env;
}

export async function createProfile(parent = os.tmpdir()) {
  if (process.platform !== "win32") throw new Error("Packaged profile acceptance requires Windows");
  const root = await mkdtemp(path.join(parent, "siteindex-acceptance-"));
  const layout = createWindowsProfileLayout(root);
  for (const directory of [layout.appDataRoot, layout.localAppDataRoot, layout.userProfileRoot,
    layout.homeRoot, layout.tempRoot, layout.tmpRoot, layout.projectRoot, layout.installDir]) {
    await mkdir(directory, { recursive: true });
  }
  return { root, layout };
}

export function redirectWindowsAppData(profile, { runRegistry = (args) => spawnSync("reg.exe", args,
  { encoding: "utf8", windowsHide: true, timeout: 15_000 }) } = {}) {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true"
    || process.env.SITEINDEX_RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("AppData registry redirection requires an isolated hosted Windows runner");
  }
  const redirect = createWindowsAppDataRedirect({ appDataRoot: profile.layout.appDataRoot, runRegistry });
  redirect.redirect();
  return redirect;
}

export async function cleanupProfile(profile, { redirect, retries = 3, intervalMs = 200, remove = rm } = {}) {
  if (redirect?.hasChanges && !redirect.restore()) {
    return { status: "harness_error", retries: 0, message: "Could not restore AppData registry" };
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await remove(profile.root, { recursive: true, force: true });
      return { status: "passed", retries: attempt };
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === retries) {
        return { status: "harness_error", retries: attempt, message: error?.message ?? String(error) };
      }
      await pause(intervalMs);
    }
  }
}

export function installedProcessCount(executable, { run = spawnSync } = {}) {
  if (process.platform !== "win32") return 0;
  const command = "$target=[IO.Path]::GetFullPath($env:SITEINDEX_ACCEPTANCE_EXE); @(Get-CimInstance Win32_Process -Filter \"Name = 'SiteIndex.exe'\" | Where-Object { $_.ExecutablePath -ieq $target }).Count";
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 20_000,
    env: { ...process.env, SITEINDEX_ACCEPTANCE_EXE: executable },
  });
  if (result.error || result.status !== 0) throw new Error("Could not inspect installed app processes");
  const count = Number(result.stdout.trim());
  if (!Number.isInteger(count) || count < 0) throw new Error("Invalid installed app process count");
  return count;
}

export async function launchInstalledApp({ executable, profile, port = 9348, timeoutMs = 60_000,
  launch = spawn, connect = chromium.connectOverCDP, inspect = installedProcessCount } = {}) {
  if (!executable || !profile) throw new Error("Installed executable and isolated profile are required");
  const endpoint = `http://127.0.0.1:${port}`;
  if (await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false)) {
    throw new Error("Acceptance CDP port is already in use");
  }
  const child = launch(executable, [`--remote-debugging-port=${port}`, "--disable-gpu"], {
    cwd: profile.root, env: isolatedEnvironment(profile), windowsHide: true, stdio: "ignore",
  });
  child.on("error", () => undefined);
  const browser = await waitForObserved(async () => {
    if (child.exitCode !== null) throw new Error("Installed app exited before CDP was ready");
    const ready = await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false);
    return ready ? connect(endpoint, { timeout: 20_000 }) : null;
  }, { timeoutMs, label: "installed app CDP" });
  const page = await waitForObserved(() => browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") && candidate.url().includes("/ui/index.html")),
  { timeoutMs: 30_000, label: "installed UI" });
  await page.waitForFunction(() => Boolean(window.siteindex), null, { timeout: 30_000 });
  return { child, browser, page, executable, inspect };
}

export async function exitNormally(session, { timeoutMs = 30_000 } = {}) {
  if (!session?.page || !session?.child) throw new Error("Installed UI is unavailable for normal exit");
  try { await session.page.evaluate(() => window.close()); } catch { /* The window may close before CDP replies. */ }
  await waitForObserved(() => session.child.exitCode !== null, { timeoutMs, label: "normal app exit" });
  if (session.child.exitCode !== 0) throw new Error(`Installed app exited with code ${session.child.exitCode}`);
  await waitForObserved(() => session.inspect(session.executable) === 0,
    { timeoutMs: 10_000, label: "installed app process cleanup" });
  await session.browser.close();
  return { method: "window.close", exitCode: 0, remainingProcesses: 0 };
}
