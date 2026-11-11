import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsProfileLayout,
  inspectContainedPath,
  inspectWindowsProfileLayout,
  WINDOWS_PROFILE_ENV_KEYS,
  windowsProfileEnvironment,
} from "../scripts/e-windows-profile-isolation.mjs";

function fakeStats(reparse = false) {
  return { isSymbolicLink: () => reparse, attributes: reparse ? 0x400 : 0 };
}

describe("isolated hosted Windows profile", () => {
  it("places all six process environment paths, project data, vault, and install under one root", async () => {
    const layout = createWindowsProfileLayout("C:\\runner-temp\\siteindex-acceptance");
    const environment = windowsProfileEnvironment(layout, { APPDATA: "C:\\runner-temp\\default-roaming" });
    const checks = await inspectWindowsProfileLayout(layout, {
      realpath: vi.fn(async (value: string) => value),
      lstat: vi.fn(async () => fakeStats()),
    });

    expect(Object.keys(environment).filter((key) => WINDOWS_PROFILE_ENV_KEYS.includes(key as never))).toEqual([
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOME",
      "TEMP",
      "TMP",
    ]);
    expect(environment.APPDATA).toBe(layout.appDataRoot);
    expect(environment.APPDATA).not.toBe("C:\\runner-temp\\default-roaming");
    expect(Object.keys(checks)).toEqual([
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOME",
      "TEMP",
      "TMP",
      "projects",
      "vault",
      "install",
    ]);
    expect(Object.values(checks).every((check) => check.withinRoot && check.noReparse)).toBe(true);
  });

  it("rejects a lexical traversal before asking the filesystem", async () => {
    const root = "C:\\runner-temp\\siteindex-acceptance";
    const realpath = vi.fn(async (value: string) => value);
    const result = await inspectContainedPath(root, path.win32.join(root, "..", "outside"), {
      realpath,
      lstat: vi.fn(async () => fakeStats()),
    });

    expect(result).toEqual({ withinRoot: false, noReparse: false });
    expect(realpath).not.toHaveBeenCalled();
  });

  it("rejects a path that resolves outside the isolation root through a junction", async () => {
    const root = "C:\\runner-temp\\siteindex-acceptance";
    const candidate = path.win32.join(root, "profile", "junction", "settings.json");
    const result = await inspectContainedPath(root, candidate, {
      realpath: vi.fn(async (value: string) =>
        value.toLowerCase() === candidate.toLowerCase() ? "C:\\runner-temp\\outside\\settings.json" : value,
      ),
      lstat: vi.fn(async () => fakeStats()),
    });

    expect(result.withinRoot).toBe(false);
  });

  it("rejects a reparse point even when its current target remains inside the root", async () => {
    const root = "C:\\runner-temp\\siteindex-acceptance";
    const candidate = path.win32.join(root, "profile", "junction");
    const result = await inspectContainedPath(root, candidate, {
      realpath: vi.fn(async (value: string) => value),
      lstat: vi.fn(async (value: string) => fakeStats(value.toLowerCase() === candidate.toLowerCase())),
    });

    expect(result.withinRoot).toBe(true);
    expect(result.noReparse).toBe(false);
  });

  it("rejects a reparse point above the temporary root", async () => {
    const root = "C:\\runner-temp\\siteindex-acceptance";
    const candidate = path.win32.join(root, "profile", "settings.json");
    const reparseAncestor = "C:\\runner-temp";
    const result = await inspectContainedPath(root, candidate, {
      realpath: vi.fn(async (value: string) => value),
      lstat: vi.fn(async (value: string) => fakeStats(value.toLowerCase() === reparseAncestor.toLowerCase())),
    });

    expect(result.withinRoot).toBe(true);
    expect(result.noReparse).toBe(false);
  });
});
