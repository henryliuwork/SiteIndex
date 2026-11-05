import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleConfig } from "@siteindex/shared";
import {
  buildWindowsTaskXml,
  createWindowsTaskRegistrar,
  decodeConsoleOutput,
  parseCodePage,
  windowsTaskDifferences,
  windowsTaskMatches,
  windowsTaskName,
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

  it("matches a sanitized real schtasks export structurally and reports expected versus actual fields", async () => {
    const actualXml = await readFile(new URL("./fixtures/windows-task-query.xml", import.meta.url), "utf8");
    const definition: WindowsTaskDefinition = {
      projectId: "sample-store",
      projectPath: "C:\\SiteIndexFixture\\sample-store",
      executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
      userId: "FIXTURE-PC\\tester",
      userSid: "S-1-5-21-111-222-333-1001",
      job: "daily",
      schedule: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "17:00" },
      options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: false },
    };

    expect(windowsTaskMatches(actualXml, definition)).toBe(true);
    expect(windowsTaskDifferences(actualXml, definition)).toEqual([]);

    const commands: { file: string; args: string[] }[] = [];
    const registrar = createWindowsTaskRegistrar({
      userId: definition.userId,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "whoami.exe") return '"FIXTURE-PC\\tester","S-1-5-21-111-222-333-1001"\r\n';
        if (file === "schtasks.exe" && args[0] === "/Query") return actualXml;
        return "";
      },
    });
    await expect(registrar.reconcile([definition], [], [], false)).resolves.toMatchObject({ mode: "system" });
    expect(commands.some(({ file, args }) => file === "schtasks.exe" && args[0] === "/Create")).toBe(false);

    const differentTime = actualXml.replace("2026-11-05T17:00:00", "2026-11-05T18:00:00");
    expect(windowsTaskDifferences(differentTime, definition)).toContainEqual({
      field: "Trigger.Time",
      expected: "17:00",
      actual: "18:00",
    });
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

  it("lists obsolete tasks once and only deletes those present in the task scheduler", async () => {
    const commands: { file: string; args: string[] }[] = [];
    const timings: { phase: string; durationMs: number }[] = [];
    const existing = new Set(["\\SiteIndex\\old-project-daily", "SiteIndex - old-project-weekly"]);
    const csv = [...existing].map((name) => `"${name}","N/A","Ready"`).join("\r\n");
    const scheduler = createWindowsTaskRegistrar({
      userId: dailyDefinition.userId,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "schtasks.exe" && args[0] === "/Query" && args.includes("/FO")) return csv;
        if (file === "schtasks.exe" && args[0] === "/Query") return buildWindowsTaskXml(dailyDefinition);
        return "SUCCESS";
      },
    });

    await expect(
      scheduler.reconcile(
        [dailyDefinition],
        ["SiteIndex - old-project-weekly", "\\SiteIndex\\missing-project-daily"],
        ["\\SiteIndex\\old-project-daily"],
        false,
        undefined,
        (phase, durationMs) => timings.push({ phase, durationMs }),
      ),
    ).resolves.toMatchObject({ mode: "system" });

    expect(
      commands.filter(({ file, args }) => file === "schtasks.exe" && args[0] === "/Query" && args.includes("/FO")),
    ).toHaveLength(1);
    expect(
      commands.filter(({ file, args }) => file === "schtasks.exe" && args[0] === "/Query" && args.includes("/TN")),
    ).toHaveLength(1);
    expect(
      commands
        .filter(({ file, args }) => file === "schtasks.exe" && args[0] === "/Delete")
        .map(({ args }) => args[2])
        .sort(),
    ).toEqual(["\\SiteIndex\\old-project-daily", "SiteIndex - old-project-weekly"].sort());
    expect(commands.some(({ file, args }) => file === "schtasks.exe" && args[0] === "/Create")).toBe(false);
    expect(timings.map(({ phase }) => phase)).toEqual(
      expect.arrayContaining(["scheduler.task_list", "scheduler.task_query", "scheduler.task_apply"]),
    );
    expect(timings.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
  });

  it("queries existing task XML concurrently with a bounded worker count", async () => {
    const jobs = ["daily", "validate", "weekly", "readme", "monthly"] as const;
    const definitions = jobs.map((job, index) => ({
      ...dailyDefinition,
      projectId: `fictional-${index}`,
      job,
      schedule: config[job],
      userId: "TEST-PC\\tester",
    }));
    const xmlByName = new Map(
      definitions.map((definition) => [
        windowsTaskName(definition.projectId, definition.job),
        buildWindowsTaskXml(definition),
      ]),
    );
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    const scheduler = createWindowsTaskRegistrar({
      userId: "TEST-PC\\tester",
      runCommand: async (file, args) => {
        if (file === "schtasks.exe" && args[0] === "/Query") {
          activeQueries += 1;
          maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
          await new Promise((resolve) => setTimeout(resolve, 15));
          activeQueries -= 1;
          return xmlByName.get(args[2] ?? "") ?? "";
        }
        return "SUCCESS";
      },
    });

    await scheduler.reconcile(definitions, [], [], false);

    expect(maximumActiveQueries).toBeGreaterThan(1);
    expect(maximumActiveQueries).toBeLessThanOrEqual(4);
  });

  it("does not recreate a matching task when an unrelated obsolete task needs elevation", async () => {
    const directory = await temporaryDirectory();
    let elevatedOperations: { action: string; name: string }[] = [];
    const scheduler = createWindowsTaskRegistrar({
      temporaryDirectory: directory,
      userId: dailyDefinition.userId,
      runCommand: async (file, args) => {
        if (file === "schtasks.exe" && args[0] === "/Query" && args.includes("/FO")) {
          return '"SiteIndex - old-project-daily","N/A","Ready"\r\n';
        }
        if (file === "schtasks.exe" && args[0] === "/Query") return buildWindowsTaskXml(dailyDefinition);
        if (file === "schtasks.exe" && args[0] === "/Delete") throw accessDenied();
        return "SUCCESS";
      },
      runElevatedScript: async (scriptPath, resultPath) => {
        const script = await readFile(scriptPath, "utf8");
        const operationPayload = /FromBase64String\('([^']+)'\)\)/.exec(script)?.[1];
        const parsed = JSON.parse(
          Buffer.from(operationPayload ?? "", "base64").toString("utf8"),
        ) as typeof elevatedOperations;
        elevatedOperations = parsed.map(({ action, name }) => ({ action, name }));
        await writeFile(
          resultPath,
          JSON.stringify({
            success: true,
            results: elevatedOperations.map((operation) => ({ ...operation, success: true })),
          }),
          "utf8",
        );
      },
    });

    await expect(
      scheduler.reconcile([dailyDefinition], ["SiteIndex - old-project-daily"], [], true),
    ).resolves.toMatchObject({ mode: "system", authorization_required: false });

    expect(elevatedOperations).toEqual([{ action: "delete", name: "SiteIndex - old-project-daily" }]);
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
    const timings: { phase: string; durationMs: number }[] = [];
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
      undefined,
      (phase, durationMs) => timings.push({ phase, durationMs }),
    );

    expect(result).toMatchObject({ mode: "system", authorization_required: false });
    expect(commands.some(({ args }) => args[0] === "/Create")).toBe(true);
    expect(beforeElevation).toHaveBeenCalledOnce();
    expect(elevated).toHaveBeenCalledOnce();
    expect(script.startsWith("\uFEFF")).toBe(true);
    const encodedOperations = /FromBase64String\('([^']+)'\)\)/.exec(script)?.[1];
    expect(script).toContain("$operations = ConvertFrom-Json -InputObject $operationsJson");
    expect(script).toContain("for ($index = 0; $index -lt $operations.Count; $index++)");
    expect(script).toContain('/TN "$($operation.name)"');
    expect(script).toContain("$ErrorActionPreference = 'Continue'");
    expect(script).toContain("$ErrorActionPreference = $previousErrorActionPreference");
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
    expect(timings.map(({ phase }) => phase)).toContain("scheduler.elevation_wait");
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

describe("Windows 控制台输出解码", () => {
  const gbkMissingTask = Uint8Array.from([
    180, 237, 206, 243, 58, 32, 207, 181, 205, 179, 213, 210, 178, 187, 181, 189, 214, 184, 182, 168, 181, 196, 206,
    196, 188, 254, 161, 163,
  ]);

  it("按 OEM 代码页 936 解码中文 schtasks 错误，避免误判为拒绝访问", () => {
    expect(decodeConsoleOutput(gbkMissingTask, 936)).toBe("错误: 系统找不到指定的文件。");
  });

  it("合法 UTF-8 输出保持不变", () => {
    expect(decodeConsoleOutput(new TextEncoder().encode("SUCCESS: 已删除"), 936)).toBe("SUCCESS: 已删除");
  });

  it("从 chcp 输出解析代码页（本地化前缀可能是乱码）", () => {
    expect(parseCodePage("Active code page: 936\r\n")).toBe(936);
    expect(parseCodePage("\u00bb\u00ee\u00b6\u00af\u00b4\u00fa\u00c2\u00eb\u00d2\u00b3: 65001")).toBe(65001);
    expect(parseCodePage("")).toBeNull();
  });
});
