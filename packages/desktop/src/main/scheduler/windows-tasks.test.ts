import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleConfig } from "@siteindex/shared";
import {
  buildWindowsTaskXml,
  createWindowsTaskRegistrar,
  windowsTaskXmlBytes,
  type WindowsTaskDefinition,
} from "./windows-tasks.js";

const config: ScheduleConfig = {
  daily: { enabled: true, days: [1, 2, 3, 4, 5], time: "02:00" },
  validate: { enabled: false, days: [1, 2, 3, 4, 5], time: "03:00" },
  weekly: { enabled: true, days: [1], time: "04:30" },
  readme: { enabled: false, days: [1], time: "05:00" },
  monthly: { enabled: true, day_of_month: 15, time: "06:15" },
  options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: false },
};

const dailyDefinition: WindowsTaskDefinition = {
  projectId: "sample-store",
  projectPath: "C:\\Users\\Tester\\Cloud & Drive\\sample-store",
  executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
  userId: "TEST-PC\\tester",
  job: "daily",
  schedule: config.daily,
  options: config.options,
  startDate: "2026-10-23",
};

const monthlyDefinition: WindowsTaskDefinition = {
  ...dailyDefinition,
  job: "monthly",
  schedule: config.monthly,
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "siteindex-windows-task-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function missingTask(): Error & { code: number; detail: string } {
  return Object.assign(new Error("schtasks.exe exited with code 1"), {
    code: 1,
    detail: "ERROR: The system cannot find the file specified.",
  });
}

function accessDenied(): Error & { code: number; detail: string } {
  return Object.assign(new Error("schtasks.exe exited with code 1"), {
    code: 1,
    detail: "ERROR: Access is denied. 0x80070005",
  });
}

describe("Windows Task Scheduler definitions", () => {
  it("generates a weekday task XML snapshot", () => {
    expect(buildWindowsTaskXml(dailyDefinition)).toMatchSnapshot();
  });

  it("generates a monthly task XML snapshot", () => {
    expect(buildWindowsTaskXml(monthlyDefinition)).toMatchSnapshot();
  });

  it("writes Task Scheduler XML as UTF-16LE with a byte-order mark", () => {
    const bytes = windowsTaskXmlBytes(buildWindowsTaskXml(dailyDefinition));
    expect([...bytes.slice(0, 2)]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain(`<UserId>${dailyDefinition.userId}</UserId>`);
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).not.toContain("HighestAvailable");
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain("<WakeToRun>true</WakeToRun>");
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain(
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    );
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toContain("<ExecutionTimeLimit>PT2H</ExecutionTimeLimit>");
  });
});

describe("Windows schedule registration", () => {
  it("registers matching user tasks with ordinary permissions and avoids UAC", async () => {
    const directory = await temporaryDirectory();
    const commands: { file: string; args: string[] }[] = [];
    const elevated = vi.fn(async () => undefined);
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "whoami.exe") return "TEST-PC\\tester\r\n";
        if (file === "schtasks.exe" && args[0] === "/Query") throw missingTask();
        return "SUCCESS";
      },
      runElevatedScript: elevated,
    });

    const result = await scheduler.reconcile(
      [dailyDefinition, monthlyDefinition],
      ["SiteIndex - sample-store-daily"],
      [],
      true,
    );

    expect(result).toMatchObject({ mode: "system", authorization_required: false });
    expect(result.registered_task_names).toEqual([
      "\\SiteIndex\\sample-store-daily",
      "\\SiteIndex\\sample-store-monthly",
    ]);
    expect(commands.filter(({ file, args }) => file === "schtasks.exe" && args[0] === "/Create")).toHaveLength(2);
    expect(elevated).not.toHaveBeenCalled();
  });

  it("recognizes an existing task despite Windows path and account casing", async () => {
    const commands: { file: string; args: string[] }[] = [];
    const existingXml = buildWindowsTaskXml(dailyDefinition);
    const scheduler = createWindowsTaskRegistrar({
      userId: "test-pc\\TESTER",
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "schtasks.exe" && args[0] === "/Query") return existingXml;
        return "";
      },
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], false)).resolves.toMatchObject({ mode: "system" });
    expect(commands.some(({ file, args }) => file === "schtasks.exe" && args[0] === "/Create")).toBe(false);
  });

  it("combines all project and job changes into one elevated PowerShell script after access denied", async () => {
    const directory = await temporaryDirectory();
    let script = "";
    const beforeElevation = vi.fn(async () => undefined);
    const elevated = vi.fn(async (scriptPath: string, resultPath: string) => {
      script = await readFile(scriptPath, "utf8");
      const encodedOperations = /FromBase64String\('([^']+)'\)\)/.exec(script)?.[1];
      const operations = JSON.parse(Buffer.from(encodedOperations!, "base64").toString("utf8")) as {
        action: string;
        name: string;
      }[];
      await writeFile(
        resultPath,
        JSON.stringify({
          success: true,
          results: operations.map((operation) => ({ ...operation, success: true })),
        }),
        "utf8",
      );
    });
    const commands: { file: string; args: string[] }[] = [];
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      beforeElevation,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "whoami.exe") return "TEST-PC\\tester\r\n";
        if (file === "schtasks.exe") throw accessDenied();
        return "";
      },
      runElevatedScript: elevated,
    });

    const result = await scheduler.reconcile(
      [dailyDefinition, monthlyDefinition],
      ["SiteIndex - sample-store-daily", "SiteIndex - old-project-readme"],
      ["\\SiteIndex\\old-project-daily"],
      true,
    );

    expect(result).toMatchObject({ mode: "system", authorization_required: false });
    expect(commands.some(({ args }) => args[0] === "/Create")).toBe(true);
    expect(beforeElevation).toHaveBeenCalledOnce();
    expect(elevated).toHaveBeenCalledOnce();
    expect(script.startsWith("\uFEFF")).toBe(true);
    const encodedOperations = /FromBase64String\('([^']+)'\)\)/.exec(script)?.[1];
    expect(script).toContain("$operations = ConvertFrom-Json -InputObject $operationsJson");
    expect(script).toContain('for ($index = 0; $index -lt $operations.Count; $index++)');
    expect(script).toContain('/TN "$($operation.name)"');
    expect(encodedOperations).toBeTruthy();
    const operations = JSON.parse(Buffer.from(encodedOperations!, "base64").toString("utf8")) as {
      action: string;
      name: string;
      xmlBase64: string | null;
    }[];
    const serialized = JSON.stringify(operations);
    const xml = Buffer.from(Buffer.from(operations[0]!.xmlBase64!, "base64").slice(2)).toString("utf16le");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<WakeToRun>true</WakeToRun>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(serialized).toContain("sample-store-daily");
    expect(serialized).toContain("sample-store-monthly");
    expect(serialized).toContain("old-project-daily");
    expect(serialized).toContain("old-project-readme");
  });

  it("falls back when the elevated result omits any requested task operation", async () => {
    const directory = await temporaryDirectory();
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      runCommand: async (file) => {
        if (file === "whoami.exe") return "TEST-PC\\tester";
        throw accessDenied();
      },
      runElevatedScript: async (_scriptPath, resultPath) => {
        await writeFile(resultPath, JSON.stringify({ success: true, results: [] }), "utf8");
      },
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], true)).resolves.toMatchObject({
      mode: "resident",
      authorization_required: true,
    });
  });

  it("retries a schtasks exit code without diagnostics through the elevation path", async () => {
    const directory = await temporaryDirectory();
    const beforeElevation = vi.fn(async () => undefined);
    const elevated = vi.fn(async (_scriptPath: string, resultPath: string) => {
      await writeFile(
        resultPath,
        JSON.stringify({
          success: true,
          results: [{ action: "create", name: "\\SiteIndex\\sample-store-daily", success: true }],
        }),
        "utf8",
      );
    });
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      beforeElevation,
      runCommand: async (file) => {
        if (file === "whoami.exe") return "TEST-PC\\tester";
        throw Object.assign(new Error("schtasks.exe 执行失败。"), { code: 1, detail: "" });
      },
      runElevatedScript: elevated,
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], true)).resolves.toMatchObject({
      mode: "system",
      authorization_required: false,
    });
    expect(beforeElevation).toHaveBeenCalledOnce();
    expect(elevated).toHaveBeenCalledOnce();
  });

  it("retries a localized schtasks exit code through elevation when its output cannot be decoded", async () => {
    const directory = await temporaryDirectory();
    const beforeElevation = vi.fn(async () => undefined);
    const elevated = vi.fn(async (_scriptPath: string, resultPath: string) => {
      await writeFile(
        resultPath,
        JSON.stringify({
          success: true,
          results: [{ action: "create", name: "\\SiteIndex\\sample-store-daily", success: true }],
        }),
        "utf8",
      );
    });
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      beforeElevation,
      runCommand: async (file) => {
        if (file === "whoami.exe") return "TEST-PC\\tester";
        throw Object.assign(new Error("schtasks.exe 执行失败。"), {
          code: 1,
          detail: "����: ϵͳ�Ҳ���ָ����·����",
        });
      },
      runElevatedScript: elevated,
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], true)).resolves.toMatchObject({
      mode: "system",
      authorization_required: false,
    });
    expect(beforeElevation).toHaveBeenCalledOnce();
    expect(elevated).toHaveBeenCalledOnce();
  });

  it("does not treat a readable non-access schtasks error as an authorization request", async () => {
    const directory = await temporaryDirectory();
    const elevated = vi.fn(async () => undefined);
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      runCommand: async (file) => {
        if (file === "whoami.exe") return "TEST-PC\\tester";
        throw Object.assign(new Error("schtasks.exe 执行失败。"), {
          code: 1,
          detail: "ERROR: The task XML is invalid.",
        });
      },
      runElevatedScript: elevated,
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], true)).rejects.toThrow("schtasks.exe 执行失败");
    expect(elevated).not.toHaveBeenCalled();
  });

  it("keeps the previous system mode on startup without showing UAC", async () => {
    const directory = await temporaryDirectory();
    const beforeElevation = vi.fn(async () => undefined);
    const elevated = vi.fn(async () => undefined);
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      beforeElevation,
      runCommand: async (file, args) => {
        if (file === "whoami.exe") return "TEST-PC\\tester";
        if (file === "schtasks.exe") throw accessDenied();
        return args.join(" ");
      },
      runElevatedScript: elevated,
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], false)).resolves.toMatchObject({
      mode: "system",
      authorization_required: true,
    });
    expect(beforeElevation).not.toHaveBeenCalled();
    expect(elevated).not.toHaveBeenCalled();
  });

  it("keeps a previously selected resident fallback on startup without showing UAC", async () => {
    const directory = await temporaryDirectory();
    const beforeElevation = vi.fn(async () => undefined);
    const elevated = vi.fn(async () => undefined);
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      runCommand: async (file, args) => {
        if (file === "whoami.exe") return "TEST-PC\\tester";
        if (file === "schtasks.exe") throw accessDenied();
        return args.join(" ");
      },
      runElevatedScript: elevated,
      beforeElevation,
    });

    await expect(scheduler.reconcile([dailyDefinition], [], [], false, "resident")).resolves.toMatchObject({
      mode: "resident",
      authorization_required: true,
    });
    expect(beforeElevation).not.toHaveBeenCalled();
    expect(elevated).not.toHaveBeenCalled();
  });
});
