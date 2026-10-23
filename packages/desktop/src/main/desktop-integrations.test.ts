import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopIntegrations } from "./desktop-integrations.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-integrations-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop system integrations", () => {
  it("installs the Windows CLI wrapper, adds user PATH, and broadcasts its change", async () => {
    const root = await tempRoot();
    const resourcesDirectory = path.join(root, "resources");
    const localAppData = path.join(root, "Local App Data");
    const cliBundle = path.join(resourcesDirectory, "cli.js");
    await mkdir(resourcesDirectory, { recursive: true });
    await writeFile(cliBundle, "process.exit(0);\n", "utf8");
    const commands: { file: string; args: string[] }[] = [];
    const integration = createDesktopIntegrations({
      platform: "win32",
      homeDirectory: path.join(root, "home"),
      localAppData,
      executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
      resourcesDirectory,
      isPackaged: true,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "reg.exe" && args[0] === "query") return "Path    REG_EXPAND_SZ    C:\\Tools";
        return "";
      },
    });

    await expect(integration.cliStatus()).resolves.toMatchObject({ installed: false });
    const status = await integration.installCli();
    expect(status).toMatchObject({ installed: true });
    const launcher = await readFile(status.path!, "utf8");
    expect(launcher).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(launcher).toContain('"C:\\Program Files\\SiteIndex\\SiteIndex.exe"');
    expect(launcher).toContain(`"${cliBundle}" %*`);
    expect(
      commands.some(({ file, args }) => file === "reg.exe" && args[0] === "add" && args.includes("REG_EXPAND_SZ")),
    ).toBe(true);
    expect(commands.some(({ file, args }) => file === "powershell.exe" && args.includes("-Command"))).toBe(true);
    await expect(integration.cliStatus()).resolves.toMatchObject({ installed: true, path: status.path });
  });

  it("installs a macOS shell launcher in ~/.local/bin", async () => {
    const root = await tempRoot();
    const resourcesDirectory = path.join(root, "resources");
    await mkdir(resourcesDirectory, { recursive: true });
    await writeFile(path.join(resourcesDirectory, "cli.js"), "process.exit(0);\n", "utf8");
    const integration = createDesktopIntegrations({
      platform: "darwin",
      homeDirectory: root,
      executablePath: path.join(root, "SiteIndex.app", "Contents", "MacOS", "SiteIndex"),
      resourcesDirectory,
      isPackaged: true,
    });

    const status = await integration.installCli();
    expect(status.path).toBe(path.join(root, ".local", "bin", "siteindex"));
    const launcher = await readFile(status.path!, "utf8");
    expect(launcher).toContain("#!/bin/sh");
    expect(launcher).toContain('"$@"');
    if (process.platform !== "win32") expect((await stat(status.path!)).mode & 0o111).not.toBe(0);
  });

  it("detects Edge from Windows App Paths and falls back to Chrome", async () => {
    const root = await tempRoot();
    const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const edgeEnvironment = { "ProgramFiles(x86)": "C:\\Program Files (x86)" };
    const edgeIntegration = createDesktopIntegrations({
      platform: "win32",
      homeDirectory: root,
      executablePath: "SiteIndex.exe",
      resourcesDirectory: root,
      isPackaged: true,
      environment: edgeEnvironment,
      runCommand: async (_file, args) => {
        if (args.includes("/ve"))
          return "HKEY_LOCAL_MACHINE\\Software\\App Paths\\msedge.exe\r\n    (Default)    REG_EXPAND_SZ    %ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe";
        return "";
      },
      isFile: async (filePath) => filePath === edgePath,
    });
    await expect(edgeIntegration.detectBrowser({ channel: "msedge", executable_path: null })).resolves.toEqual({
      available: true,
      name: "Microsoft Edge",
      path: edgePath,
    });

    const chromeIntegration = createDesktopIntegrations({
      platform: "win32",
      homeDirectory: root,
      executablePath: "SiteIndex.exe",
      resourcesDirectory: root,
      isPackaged: true,
      environment: { ProgramFiles: "C:\\Program Files" },
      runCommand: async (_file, args) => {
        if (args.includes("/ve")) throw Object.assign(new Error("missing App Paths key"), { code: 1 });
        return "";
      },
      isFile: async (filePath) => filePath.toLowerCase().includes("chrome.exe"),
    });
    await expect(chromeIntegration.detectBrowser({ channel: "msedge", executable_path: null })).resolves.toMatchObject({
      available: true,
      name: "Google Chrome",
    });
    const preferredChrome = await chromeIntegration.detectBrowser({ channel: "chrome", executable_path: null });
    expect(preferredChrome).toMatchObject({ available: true, name: "Google Chrome" });
  });

  it("checks a configured custom browser path directly", async () => {
    const root = await tempRoot();
    const customPath = path.join(root, "browser.exe");
    const isFile = vi.fn(async (value: string) => value === customPath);
    const integration = createDesktopIntegrations({
      platform: "win32",
      homeDirectory: root,
      executablePath: "SiteIndex.exe",
      resourcesDirectory: root,
      isPackaged: true,
      isFile,
    });

    await expect(integration.detectBrowser({ channel: "custom", executable_path: customPath })).resolves.toEqual({
      available: true,
      name: "自定义浏览器",
      path: customPath,
    });
    expect(isFile).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform !== "win32" || process.env.SITEINDEX_WINDOWS_CLI_INSTALL_E2E !== "1")(
    "installs and removes a temporary CLI entry in the current user's PATH",
    async () => {
      const root = await tempRoot();
      const resourcesDirectory = path.join(root, "resources");
      await mkdir(resourcesDirectory, { recursive: true });
      await writeFile(path.join(resourcesDirectory, "cli.js"), "process.exit(0);\n", "utf8");

      let previousPath: { type: string; value: string } | null = null;
      try {
        const { stdout } = await execFileAsync("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], {
          windowsHide: true,
        });
        const match = /^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s+(.+)$/im.exec(stdout);
        if (match) previousPath = { type: match[1]!, value: match[2]!.trim() };
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || String(error.code) !== "1") throw error;
      }

      const integration = createDesktopIntegrations({
        platform: "win32",
        homeDirectory: path.join(root, "home"),
        localAppData: path.join(root, "Local App Data"),
        executablePath: path.join(root, "SiteIndex.exe"),
        resourcesDirectory,
        isPackaged: true,
      });
      try {
        const installed = await integration.installCli();
        expect(installed.installed).toBe(true);
        const { stdout } = await execFileAsync("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], {
          windowsHide: true,
        });
        expect(stdout.toLowerCase()).toContain(path.dirname(installed.path!).toLowerCase());
      } finally {
        if (previousPath) {
          await execFileAsync(
            "reg.exe",
            ["add", "HKCU\\Environment", "/v", "Path", "/t", previousPath.type, "/d", previousPath.value, "/f"],
            { windowsHide: true },
          );
        } else {
          await execFileAsync("reg.exe", ["delete", "HKCU\\Environment", "/v", "Path", "/f"], {
            windowsHide: true,
          }).catch(() => undefined);
        }
        await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Add-Type -Namespace SiteIndex -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, System.UInt32 Msg, System.UIntPtr wParam, string lParam, System.UInt32 fuFlags, System.UInt32 uTimeout, out System.UIntPtr lpdwResult);'; $result = [System.UIntPtr]::Zero; [void][SiteIndex.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`,
          ],
          { windowsHide: true },
        );
      }
    },
    30_000,
  );
});
