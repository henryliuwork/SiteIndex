import { describe, expect, it } from "vitest";
import { createWindowsAppDataRedirect } from "../scripts/windows-appdata-redirect.mjs";

const userShellFolders = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
const shellFolders = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders";

function fakeRegistry(options: { failWriteCall?: number; failRestoreKey?: string } = {}) {
  const values = new Map([
    [userShellFolders, { type: "REG_EXPAND_SZ", value: "%USERPROFILE%\\AppData\\Roaming" }],
    [shellFolders, { type: "REG_SZ", value: "C:\\Synthetic\\Roaming" }],
  ]);
  const calls: string[] = [];
  let writeCalls = 0;
  const runRegistry = (args: string[]) => {
    const [operation, key] = args;
    calls.push(`${operation}:${key}`);
    if (operation === "query") {
      const current = values.get(key!);
      return current
        ? { status: 0, stdout: `    AppData    ${current.type}    ${current.value}\r\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "missing" };
    }
    if (operation === "add") {
      writeCalls += 1;
      const restoreAttempt = options.failRestoreKey === key && writeCalls > 2;
      if (writeCalls === options.failWriteCall || restoreAttempt) return { status: 1, stdout: "", stderr: "failed" };
      const type = args[args.indexOf("/t") + 1]!;
      const value = args[args.indexOf("/d") + 1]!;
      values.set(key!, { type, value });
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { values, calls, runRegistry };
}

describe("isolated Windows AppData registry redirect", () => {
  it("restores both shell-folder values in reverse order", () => {
    const registry = fakeRegistry();
    const redirect = createWindowsAppDataRedirect({ appDataRoot: "D:\\runner-temp\\profile\\roaming", runRegistry: registry.runRegistry });

    redirect.redirect();
    expect(redirect.redirected).toBe(true);
    expect(redirect.canRemoveProfileRoot).toBe(false);
    expect(registry.values.get(userShellFolders)?.value).toBe("D:\\runner-temp\\profile\\roaming");
    expect(registry.values.get(shellFolders)?.value).toBe("D:\\runner-temp\\profile\\roaming");

    expect(redirect.restore()).toBe(true);
    expect(registry.calls.slice(-2)).toEqual([`add:${shellFolders}`, `add:${userShellFolders}`]);
    expect(registry.values.get(userShellFolders)).toEqual({ type: "REG_EXPAND_SZ", value: "%USERPROFILE%\\AppData\\Roaming" });
    expect(registry.values.get(shellFolders)).toEqual({ type: "REG_SZ", value: "C:\\Synthetic\\Roaming" });
    expect(redirect.canRemoveProfileRoot).toBe(true);
  });

  it("restores the first registry value when the second redirect write fails", () => {
    const registry = fakeRegistry({ failWriteCall: 2 });
    const redirect = createWindowsAppDataRedirect({ appDataRoot: "D:\\runner-temp\\profile\\roaming", runRegistry: registry.runRegistry });

    expect(() => redirect.redirect()).toThrow("Could not redirect");
    expect(redirect.hasChanges).toBe(true);
    expect(redirect.canRemoveProfileRoot).toBe(false);
    expect(redirect.restore()).toBe(true);
    expect(registry.calls.slice(-2)).toEqual([`add:${shellFolders}`, `add:${userShellFolders}`]);
    expect(registry.values.get(userShellFolders)?.value).toBe("%USERPROFILE%\\AppData\\Roaming");
    expect(registry.values.get(shellFolders)?.value).toBe("C:\\Synthetic\\Roaming");
    expect(redirect.canRemoveProfileRoot).toBe(true);
  });

  it("refuses isolated-root cleanup when restoring a registry value fails", () => {
    const registry = fakeRegistry({ failRestoreKey: userShellFolders });
    const redirect = createWindowsAppDataRedirect({ appDataRoot: "D:\\runner-temp\\profile\\roaming", runRegistry: registry.runRegistry });

    redirect.redirect();
    expect(redirect.restore()).toBe(false);
    expect(redirect.restored).toBe(false);
    expect(redirect.canRemoveProfileRoot).toBe(false);
  });
});
