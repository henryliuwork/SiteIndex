import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleConfig } from "@siteindex/shared";
import {
  buildLaunchAgentPlist,
  createSystemScheduler,
  launchAgentLabel,
  type ScheduleProjectDefinition,
} from "./schedule.js";
import { buildWindowsTaskXml, windowsTaskName, type WindowsTaskDefinition } from "./windows-tasks.js";

const config: ScheduleConfig = {
  daily: { enabled: true, days: [1, 2, 3, 4, 5], time: "02:00" },
  validate: { enabled: false, days: [1, 2, 3, 4, 5], time: "03:00" },
  weekly: { enabled: true, days: [1], time: "04:30" },
  readme: { enabled: false, days: [1], time: "05:00" },
  monthly: { enabled: true, day_of_month: 15, time: "06:15" },
  options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: false },
};

const projects: ScheduleProjectDefinition[] = [
  {
    projectId: "fixture-store",
    projectPath: "C:\\Synthetic\\fixture-store",
    config,
    isThisDevice: true,
  },
];

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "siteindex-system-task-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function windowsDefinition(projectId: string, projectPath: string): WindowsTaskDefinition {
  return {
    projectId,
    projectPath,
    executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
    userId: "TEST-PC\\tester",
    job: "daily",
    schedule: config.daily,
    options: config.options,
    startDate: "2026-11-01",
  };
}

function windowsRuntimeCsv(taskName: string, status = "Ready"): string {
  return [
    ["FIXTURE-PC", taskName, "11/6/2026 10:00:00 AM", status, "Interactive/Background", "11/5/2026 2:00:00 AM", "0"],
    ["FIXTURE-PC", "\\Other\\backup", "N/A", "Ready", "Interactive/Background", "N/A", "0"],
  ]
    .map((row) => row.map((value) => `"${value}"`).join(","))
    .join("\r\n");
}

describe("read-only system scheduled task listing", () => {
  it("lists Windows task status, timing, trigger and config agreement without changing tasks", async () => {
    const taskName = windowsTaskName("fixture-store", "daily");
    const xml = buildWindowsTaskXml(windowsDefinition("fixture-store", projects[0]!.projectPath));
    const runCommand = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("/FO") && args.includes("/V")) return windowsRuntimeCsv(taskName, "正在运行");
      if (args.includes("/XML")) return xml;
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
      runCommand,
    });

    const rows = await scheduler.listSystemTasks(projects);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskName,
      projectId: "fixture-store",
      orphaned: false,
      job: "daily",
      systemState: "Running",
      lastRunAt: new Date("11/5/2026 2:00:00 AM").toISOString(),
      lastResult: "0",
      nextRunAt: new Date("11/6/2026 10:00:00 AM").toISOString(),
      triggerSummary: "每周 一、二、三、四、五 02:00",
      commandPath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
      configMatches: true,
      differences: [],
    });
    expect(runCommand.mock.calls.every(([file, args]) => file === "schtasks.exe" && args[0] === "/Query")).toBe(true);
  });

  it("marks an unregistered Windows task as orphaned and reports disabled state", async () => {
    const taskName = windowsTaskName("moved-store", "daily");
    const xml = buildWindowsTaskXml(windowsDefinition("moved-store", "D:\\Old\\moved-store"));
    const runCommand = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("/FO") && args.includes("/V")) return windowsRuntimeCsv(taskName, "已禁用");
      if (args.includes("/XML")) return xml;
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
      runCommand,
    });

    const rows = await scheduler.listSystemTasks(projects);

    expect(rows).toMatchObject([
      {
        projectId: null,
        orphaned: true,
        systemState: "Disabled",
        configMatches: null,
        differences: ["任务未关联到当前登记项目。"],
      },
    ]);
  });

  it("lists macOS LaunchAgents and inspects their loaded state without modifying files", async () => {
    const homeDirectory = await temporaryDirectory();
    const agentDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
    await mkdir(agentDirectory, { recursive: true });
    const definition = {
      projectId: "fixture-store",
      projectPath: "/Synthetic/fixture-store",
      executablePath: "/Applications/SiteIndex.app/Contents/MacOS/SiteIndex",
      job: "daily" as const,
      schedule: config.daily,
    };
    const label = launchAgentLabel(definition.projectId, definition.job);
    const plistPath = path.join(agentDirectory, `${label}.plist`);
    const plist = buildLaunchAgentPlist(definition);
    await writeFile(plistPath, plist, "utf8");
    const runCommand = vi.fn(async () => "state = waiting\nlast exit code = 0\n");
    const scheduler = createSystemScheduler({
      platform: "darwin",
      executablePath: definition.executablePath,
      homeDirectory,
      uid: 501,
      runCommand,
    });

    const rows = await scheduler.listSystemTasks(
      projects.map((project) => ({ ...project, projectPath: definition.projectPath })),
    );

    expect(rows).toMatchObject([
      {
        taskName: label,
        projectId: "fixture-store",
        orphaned: false,
        job: "daily",
        systemState: "Ready",
        lastRunAt: null,
        lastResult: "0",
        triggerSummary: "每周 一、二、三、四、五 02:00",
        commandPath: definition.executablePath,
        configMatches: true,
        differences: [],
      },
    ]);
    expect(rows[0]?.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith("launchctl", ["print", `gui/501/${label}`]);
    expect(await readFile(plistPath, "utf8")).toBe(plist);
  });
});
