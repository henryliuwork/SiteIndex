import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppSettings, BrowserStatus, CliStatus, SiteIndexError } from "@siteindex/shared";

type BrowserSettings = AppSettings["browser"];
type CommandRunner = (file: string, args: string[]) => Promise<string>;

export interface DesktopIntegrations {
  cliStatus(): Promise<CliStatus>;
  installCli(): Promise<CliStatus>;
  detectBrowser(settings: BrowserSettings): Promise<BrowserStatus>;
}

export interface DesktopIntegrationsOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppData?: string;
  executablePath: string;
  resourcesDirectory: string;
  isPackaged: boolean;
  runCommand?: CommandRunner;
  isFile?: (filePath: string) => Promise<boolean>;
  environment?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile);
const WINDOWS_APP_PATH_KEYS: Record<"msedge" | "chrome", string[]> = {
  msedge: [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
  ],
  chrome: [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  ],
};

const WINDOWS_ENVIRONMENT_BROADCAST = `
Add-Type -Namespace SiteIndex -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, System.UInt32 Msg, System.UIntPtr wParam, string lParam, System.UInt32 fuFlags, System.UInt32 uTimeout, out System.UIntPtr lpdwResult);'
$result = [System.UIntPtr]::Zero
[void][SiteIndex.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`.trim();

function integrationError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultCommandRunner(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileAsync(file, args, { windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" })
      .then(({ stdout }) => resolve(stdout))
      .catch((error: unknown) => reject(error));
  });
}

async function defaultIsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function escapeCmdPath(value: string): string {
  return value.replaceAll("%", "%%");
}

function escapeShellPath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function registryValue(output: string): string | null {
  const line = output.split(/\r?\n/).find((entry) => /\bREG_(?:EXPAND_)?SZ\b/i.test(entry));
  if (!line) return null;
  const value = /\bREG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line)?.[1]?.trim();
  if (!value) return null;
  return value.replace(/^"(.*)"$/, "$1");
}

function expandWindowsEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (_match, key: string) => environment[key] ?? `%${key}%`);
}

function windowsBrowserCandidates(
  browser: "msedge" | "chrome",
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string[] {
  const programFiles = environment.ProgramFiles;
  const programFilesX86 = environment["ProgramFiles(x86)"];
  const localAppData = environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
  if (browser === "msedge") {
    return [
      ...(programFilesX86 ? [path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")] : []),
      ...(programFiles ? [path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")] : []),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return [
    ...(programFiles ? [path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe")] : []),
    ...(programFilesX86 ? [path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")] : []),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ];
}

function macBrowserCandidates(browser: "msedge" | "chrome", homeDirectory: string): string[] {
  const appName = browser === "msedge" ? "Microsoft Edge" : "Google Chrome";
  const executableName = browser === "msedge" ? "Microsoft Edge" : "Google Chrome";
  return [
    path.join("/Applications", `${appName}.app`, "Contents", "MacOS", executableName),
    path.join(homeDirectory, "Applications", `${appName}.app`, "Contents", "MacOS", executableName),
  ];
}

export function createDesktopIntegrations(options: DesktopIntegrationsOptions): DesktopIntegrations {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const localAppData = options.localAppData ?? environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const isFile = options.isFile ?? defaultIsFile;
  const cliPath =
    platform === "win32"
      ? path.join(localAppData, "SiteIndex", "bin", "siteindex.cmd")
      : platform === "darwin"
        ? path.join(homeDirectory, ".local", "bin", "siteindex")
        : null;

  async function addWindowsUserPath(directory: string): Promise<void> {
    let existing = "";
    try {
      existing = registryValue(await runCommand("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"])) ?? "";
    } catch (error) {
      const code = isRecord(error) ? String(error.code ?? "") : "";
      if (code !== "1") throw error;
    }

    const normalized = normalizePath(directory);
    const entries = existing
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!entries.some((entry) => normalizePath(entry) === normalized)) entries.push(directory);
    await runCommand("reg.exe", [
      "add",
      "HKCU\\Environment",
      "/v",
      "Path",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      entries.join(";"),
      "/f",
    ]);
    await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENVIRONMENT_BROADCAST]);
  }

  async function writeCliLauncher(): Promise<void> {
    if (!cliPath) throw integrationError("CONFIG_INVALID", "当前系统不支持安装 SiteIndex 命令行。", platform);
    const bundledCliPath = path.join(options.resourcesDirectory, "cli.js");
    if (!options.isPackaged || !(await isFile(bundledCliPath))) {
      throw integrationError("CONFIG_INVALID", "请先安装正式版 SiteIndex，再安装命令行。", bundledCliPath);
    }

    await mkdir(path.dirname(cliPath), { recursive: true });
    const content =
      platform === "win32"
        ? `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${escapeCmdPath(options.executablePath)}" "${escapeCmdPath(bundledCliPath)}" %*\r\nexit /b %ERRORLEVEL%\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${escapeShellPath(options.executablePath)} ${escapeShellPath(bundledCliPath)} "$@"\n`;
    const temporaryPath = `${cliPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode: platform === "darwin" ? 0o755 : 0o600 });
      if (platform === "darwin") await chmod(temporaryPath, 0o755);
      await rename(temporaryPath, cliPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    if (platform === "win32") await addWindowsUserPath(path.dirname(cliPath));
  }

  async function findWindowsBrowser(browser: "msedge" | "chrome"): Promise<string | null> {
    for (const registryKey of WINDOWS_APP_PATH_KEYS[browser]) {
      try {
        const rawValue = registryValue(await runCommand("reg.exe", ["query", registryKey, "/ve"]));
        const value = rawValue ? expandWindowsEnvironment(rawValue, environment) : null;
        if (value && (await isFile(value))) return value;
      } catch {
        // App Paths 注册项不是必填项，继续检查其他注册表视图和常见目录。
      }
    }
    for (const candidate of windowsBrowserCandidates(browser, environment, homeDirectory)) {
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }

  async function findMacBrowser(browser: "msedge" | "chrome"): Promise<string | null> {
    for (const candidate of macBrowserCandidates(browser, homeDirectory)) {
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }

  return {
    async cliStatus() {
      if (!cliPath) return { installed: false, path: null };
      return { installed: await isFile(cliPath), path: cliPath };
    },
    async installCli() {
      await writeCliLauncher();
      return { installed: true, path: cliPath };
    },
    async detectBrowser(settings) {
      if (settings.channel === "custom") {
        const executablePath = settings.executable_path;
        const available = Boolean(executablePath && (await isFile(executablePath)));
        return { available, name: available ? "自定义浏览器" : null, path: available ? executablePath : null };
      }
      const order: ("msedge" | "chrome")[] =
        settings.channel === "chrome" ? ["chrome", "msedge"] : ["msedge", "chrome"];
      for (const browser of order) {
        const executablePath =
          platform === "win32"
            ? await findWindowsBrowser(browser)
            : platform === "darwin"
              ? await findMacBrowser(browser)
              : null;
        if (executablePath) {
          return {
            available: true,
            name: browser === "msedge" ? "Microsoft Edge" : "Google Chrome",
            path: executablePath,
          };
        }
      }
      return { available: false, name: null, path: null };
    },
  };
}
