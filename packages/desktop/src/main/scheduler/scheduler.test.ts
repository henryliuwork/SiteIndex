import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchAgentPlist,
  buildWindowsTaskXml,
  calculateNextRuns,
  createSystemScheduler,
  windowsRootTaskName,
  windowsTaskName,
  type LaunchAgentDefinition,
  type WindowsTaskDefinition,
} from "./schedule.js";
import type { ScheduleConfig } from "@siteindex/shared";

const config: ScheduleConfig = {
  daily: { enabled: true, days: [1, 2, 3, 4, 5], time: "02:00" },
  validate: { enabled: false, days: [1, 2, 3, 4, 5], time: "03:00" },
  weekly: { enabled: true, days: [1], time: "04:30" },
  readme: { enabled: false, days: [1], time: "05:00" },
  monthly: { enabled: true, day_of_month: 15, time: "06:15" },
  options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: false },
};

const windowsDefinition: WindowsTaskDefinition = {
  projectId: "sample-store",
  projectPath: "C:\Users\Tester\Cloud & Drive\sample-store",
  executablePath: "C:\Program Files\SiteIndex\SiteIndex.exe",
  userId: "TEST-PC\Tester",
  job: "daily",
  schedule: config.daily,
  options: config.options,
  now: new Date(2026, 9, 23, 11, 30, 0),
};

const monthlyWindowsDefinition: WindowsTaskDefinition = {
  ...windowsDefinition,
  job: "monthly",
  schedule: config.monthly,
};

const macDefinition: LaunchAgentDefinition = {
  projectId: "sample-store",
  projectPath: "/Users/tester/Cloud & Drive/sample-store",
  executablePath: "/Applications/SiteIndex.app/Contents/MacOS/SiteIndex",
  job: "daily",
  schedule: config.daily,
};

const monthlyMacDefinition: LaunchAgentDefinition = {
  ...macDefinition,
  job: "monthly",
  schedule: config.monthly,
};

const sundayMacDefinition: LaunchAgentDefinition = {
  ...macDefinition,
  job: "weekly",
  schedule: { enabled: true, days: [7], time: "02:00" },
};

describe("system schedule definitions", () => {
  it("generates Windows weekday XML", () => {
    expect(buildWindowsTaskXml(windowsDefinition)).toMatchSnapshot();
  });

  it("generates Windows monthly XML", () => {
    expect(buildWindowsTaskXml(monthlyWindowsDefinition)).toMatchSnapshot();
  });

  it("generates a macOS weekday LaunchAgent plist", () => {
    expect(buildLaunchAgentPlist(macDefinition)).toMatchSnapshot();
  });

  it("generates a macOS monthly LaunchAgent plist", () => {
    expect(buildLaunchAgentPlist(monthlyMacDefinition)).toMatchSnapshot();
  });

  it("uses launchd weekday zero for Sunday", () => {
    expect(buildLaunchAgentPlist(sundayMacDefinition)).toMatchSnapshot();
  });

  it("calculates upcoming local schedule times and leaves disabled jobs empty", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 1, 0, 0));
    const nextRuns = calculateNextRuns(config);
    expect(nextRuns).toEqual([
      { job: "daily", at: new Date(2026, 9, 23, 2, 0, 0).toISOString() },
      { job: "validate", at: null },
      { job: "weekly", at: new Date(2026, 9, 26, 4, 30, 0).toISOString() },
      { job: "readme", at: null },
      { job: "monthly", at: new Date(2026, 10, 15, 6, 15, 0).toISOString() },
    ]);
    vi.useRealTimers();
  });

  it("writes UTF-16LE task XML and uses schtasks to register and query Windows tasks", async () => {
    const commands: { file: string; args: string[] }[] = [];
    const tasks = new Set<string>();
    let registeredXml = "";
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: windowsDefinition.executablePath,
      userId: windowsDefinition.userId,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "schtasks.exe" && args[0] === "/Create") {
          const xmlPath = args[args.indexOf("/XML") + 1]!;
          const bytes = await readFile(xmlPath);
          expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
          registeredXml = bytes.subarray(2).toString("utf16le");
          tasks.add(args[args.indexOf("/TN") + 1]!);
          return "created";
        }
        if (file === "schtasks.exe" && args[0] === "/Query") {
          if (!tasks.has(args[args.indexOf("/TN") + 1]!)) throw new Error("missing task");
          return "task xml";
        }
        if (file === "schtasks.exe" && args[0] === "/Delete") {
          tasks.delete(args[args.indexOf("/TN") + 1]!);
          return "deleted";
        }
        return "ok";
      },
    });
    const windowsConfig: ScheduleConfig = {
      ...config,
      validate: { ...config.validate, enabled: false },
      weekly: { ...config.weekly, enabled: false },
      readme: { ...config.readme, enabled: false },
      monthly: { ...config.monthly, enabled: false },
    };

    const state = await scheduler.sync("sample-store", windowsDefinition.projectPath, windowsConfig);

    expect(state.registered).toBe(true);
    expect(registeredXml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(registeredXml).toContain("<ExecutionTimeLimit>PT2H</ExecutionTimeLimit>");
    expect(commands.some(({ file, args }) => file === "schtasks.exe" && args[0] === "/Create")).toBe(true);
    expect(commands.some(({ file, args }) => file === "schtasks.exe" && args[0] === "/Query")).toBe(true);
    await scheduler.removeProject("sample-store");
    expect(tasks.size).toBe(0);
  });

  it("falls back to a root task after Access Denied and removes either registration path", async () => {
    const commands: { file: string; args: string[] }[] = [];
    const tasks = new Set<string>();
    let userIdXml = "";
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: windowsDefinition.executablePath,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        if (file === "whoami.exe") return "TEST-PC\\Tester\r\n";
        const taskName = args[args.indexOf("/TN") + 1];
        if (file === "schtasks.exe" && args[0] === "/Create") {
          if (taskName === windowsTaskName("sample-store", "daily")) {
            throw Object.assign(new Error("schtasks failed"), { detail: "Access is denied." });
          }
          const xmlPath = args[args.indexOf("/XML") + 1]!;
          const bytes = await readFile(xmlPath);
          userIdXml = bytes.subarray(2).toString("utf16le");
          tasks.add(taskName!);
          return "created";
        }
        if (file === "schtasks.exe" && args[0] === "/Query") {
          if (!tasks.has(taskName!)) throw new Error("missing task");
          return "task xml";
        }
        if (file === "schtasks.exe" && args[0] === "/Delete") {
          tasks.delete(taskName!);
          return "deleted";
        }
        return "ok";
      },
    });
    const windowsConfig: ScheduleConfig = {
      ...config,
      validate: { ...config.validate, enabled: false },
      weekly: { ...config.weekly, enabled: false },
      readme: { ...config.readme, enabled: false },
      monthly: { ...config.monthly, enabled: false },
    };

    const state = await scheduler.sync("sample-store", windowsDefinition.projectPath, windowsConfig);

    expect(state.registered).toBe(true);
    expect(commands.some(({ args }) => args[0] === "/Create" && args.includes(windowsTaskName("sample-store", "daily")))).toBe(true);
    expect(commands.some(({ args }) => args[0] === "/Create" && args.includes(windowsRootTaskName("sample-store", "daily")))).toBe(true);
    expect(commands.some(({ args }) => args[0] === "/Query" && args.includes(windowsRootTaskName("sample-store", "daily")))).toBe(true);
    expect(userIdXml).toContain("<UserId>TEST-PC\\Tester</UserId>");
    await scheduler.removeProject("sample-store");
    expect(tasks.size).toBe(0);
  });

  it("writes and loads macOS LaunchAgents through launchctl", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "siteindex-launchd-test-"));
    const commands: { file: string; args: string[] }[] = [];
    const scheduler = createSystemScheduler({
      platform: "darwin",
      executablePath: macDefinition.executablePath,
      homeDirectory,
      uid: 501,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        return "loaded";
      },
    });
    const macConfig: ScheduleConfig = {
      ...config,
      validate: { ...config.validate, enabled: false },
      weekly: { ...config.weekly, enabled: false },
      readme: { ...config.readme, enabled: false },
      monthly: { ...config.monthly, enabled: false },
    };
    try {
      const state = await scheduler.sync("sample-store", macDefinition.projectPath, macConfig);
      expect(state.registered).toBe(true);
      expect(commands.some(({ file, args }) => file === "launchctl" && args[0] === "bootstrap")).toBe(true);
      await expect(access(path.join(homeDirectory, "Library", "LaunchAgents"))).resolves.toBeUndefined();
      await scheduler.removeProject("sample-store");
      expect(commands.some(({ file, args }) => file === "launchctl" && args[0] === "bootout")).toBe(true);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
