import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsTaskXml,
  buildLaunchAgentPlist,
  calculateNextRuns,
  createSystemScheduler,
  launchAgentLabel,
  projectPathFromWindowsTaskXml,
  scheduledOccurrenceKey,
  type LaunchAgentDefinition,
  type ScheduleProjectDefinition,
} from "./schedule.js";
import type { ScheduleConfig } from "@siteindex/shared";
import { windowsTaskName, type WindowsTaskDefinition, type WindowsTaskRegistrar } from "./windows-tasks.js";

const config: ScheduleConfig = {
  daily: { enabled: true, days: [1, 2, 3, 4, 5], time: "02:00" },
  validate: { enabled: false, days: [1, 2, 3, 4, 5], time: "03:00" },
  weekly: { enabled: true, days: [1], time: "04:30" },
  readme: { enabled: false, days: [1], time: "05:00" },
  monthly: { enabled: true, day_of_month: 15, time: "06:15" },
  options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: false },
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
  it("extracts the project path from a SiteIndex Windows task XML action", () => {
    expect(
      projectPathFromWindowsTaskXml(
        "<Task><Actions><Exec><Arguments>--run-job &quot;C:\\Synthetic Projects\\sample-store&quot; daily</Arguments></Exec></Actions></Task>",
      ),
    ).toBe("C:\\Synthetic Projects\\sample-store");
    expect(projectPathFromWindowsTaskXml("<Task><Actions /></Task>")).toBeNull();
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

  it("recognizes a due weekday occurrence and respects the missed-run window", () => {
    expect(scheduledOccurrenceKey("daily", config, new Date(2026, 9, 26, 1, 59, 59))).toBeNull();
    expect(scheduledOccurrenceKey("daily", config, new Date(2026, 9, 26, 2, 0, 0))).toBe("2026-10-26T02:00");
    expect(scheduledOccurrenceKey("daily", config, new Date(2026, 9, 25, 2, 0, 0))).toBeNull();

    const noCatchUp = { ...config, options: { ...config.options, run_if_missed: false } };
    expect(scheduledOccurrenceKey("daily", noCatchUp, new Date(2026, 9, 26, 2, 0, 59))).toBe("2026-10-26T02:00");
    expect(scheduledOccurrenceKey("daily", noCatchUp, new Date(2026, 9, 26, 2, 1, 0))).toBeNull();
  });

  it("tracks Windows system registration status from the scheduler state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-windows-schedule-test-"));
    try {
      const statePath = path.join(directory, "state.json");
      const projectPath = path.join(directory, "sample-store");
      await mkdir(projectPath);
      const registrar = {
        reconcile: vi.fn(async () => ({
          mode: "system" as const,
          authorization_required: false,
          registered_task_names: [
            "\\SiteIndex\\sample-store-daily",
            "\\SiteIndex\\sample-store-weekly",
            "\\SiteIndex\\sample-store-monthly",
          ],
        })),
      };
      const scheduler = createSystemScheduler({
        platform: "win32",
        executablePath: "unused.exe",
        runtimeStatePath: statePath,
        windowsTaskRegistrar: registrar,
      });
      await scheduler.reconcile([{ projectId: "sample-store", projectPath, config, isThisDevice: true }], false);
      await expect(scheduler.getState("sample-store", projectPath, config)).resolves.toMatchObject({
        registered: true,
      });
      await expect(scheduler.getRuntimeStatus()).resolves.toEqual({ mode: "system", authorization_required: false });
      expect(registrar.reconcile).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("requests removal of every task name for an explicitly removed project", async () => {
    const registrar = {
      reconcile: vi.fn(async (..._args: Parameters<WindowsTaskRegistrar["reconcile"]>) => ({
        mode: "system" as const,
        authorization_required: false,
        registered_task_names: [],
      })),
    };
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "unused.exe",
      windowsTaskRegistrar: registrar,
    });
    await scheduler.reconcile([], true, ["sample-store"]);
    const obsolete = registrar.reconcile.mock.calls[0]?.[1];
    expect(obsolete).toContain("\\SiteIndex\\sample-store-daily");
    expect(obsolete).toContain("SiteIndex - sample-store-daily");
    expect(obsolete).toHaveLength(10);
  });

  it("preserves known-cloud Windows tasks, including a temporarily unavailable cloud path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-cloud-schedule-test-"));
    const statePath = path.join(directory, "state.json");
    const existingCloudPath = path.join(directory, "cloud-project");
    const offlineCloudPath = path.join(directory, "offline-cloud-project");
    const legacyCloudPath = path.join(directory, "legacy-cloud-project");
    const localPath = path.join(directory, "local-project");
    await Promise.all([mkdir(existingCloudPath), mkdir(localPath)]);
    const existingCloudTask = "\\SiteIndex\\cloud-project-daily";
    const offlineCloudTask = "SiteIndex - offline-cloud-project-daily";
    const legacyCloudTask = "\\SiteIndex\\legacy-cloud-project-daily";
    const localTask = "\\SiteIndex\\local-project-daily";
    await writeFile(
      statePath,
      JSON.stringify({
        mode: "system",
        authorization_required: false,
        registered_task_names: [existingCloudTask, offlineCloudTask, legacyCloudTask],
        project_paths: {
          "cloud-project": existingCloudPath,
          "offline-cloud-project": offlineCloudPath,
        },
        orphaned_tasks: [],
      }),
      "utf8",
    );
    const registrar = {
      reconcile: vi.fn(async (..._args: Parameters<WindowsTaskRegistrar["reconcile"]>) => ({
        mode: "system" as const,
        authorization_required: false,
        registered_task_names: [localTask],
      })),
    };
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Synthetic\\SiteIndex.exe",
      runtimeStatePath: statePath,
      windowsTaskRegistrar: registrar,
      runCommand: async (_file, args) => {
        expect(args).toEqual(["/Query", "/TN", legacyCloudTask, "/XML"]);
        return `<Task><Actions><Exec><Arguments>--run-job &quot;${legacyCloudPath}&quot; daily</Arguments></Exec></Actions></Task>`;
      },
      inspectStorageLocation: async (projectPath) =>
        projectPath === existingCloudPath || projectPath === offlineCloudPath || projectPath === legacyCloudPath
          ? { status: "known-cloud", provider: "Fixture Drive" }
          : { status: "unknown" },
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await scheduler.reconcile(
        [
          { projectId: "cloud-project", projectPath: existingCloudPath, config, isThisDevice: true },
          { projectId: "local-project", projectPath: localPath, config, isThisDevice: true },
        ],
        false,
      );
      const [desired, obsolete, previous] = registrar.reconcile.mock.calls[0]!;
      expect(new Set(desired.map(({ projectId }) => projectId))).toEqual(new Set(["local-project"]));
      expect(obsolete).not.toContain(existingCloudTask);
      expect(obsolete).not.toContain("\\SiteIndex\\offline-cloud-project-daily");
      expect(previous).not.toContain(existingCloudTask);
      expect(previous).not.toContain(offlineCloudTask);
      expect(previous).not.toContain(legacyCloudTask);

      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        registered_task_names: string[];
        project_paths: Record<string, string>;
        orphaned_tasks: { taskName: string }[];
      };
      expect(state.registered_task_names).toEqual([existingCloudTask, legacyCloudTask, localTask, offlineCloudTask].sort((a, b) => a.localeCompare(b)));
      expect(state.project_paths["offline-cloud-project"]).toBe(offlineCloudPath);
      expect(state.project_paths["legacy-cloud-project"]).toBe(legacyCloudPath);
      expect(state.orphaned_tasks).toEqual([]);
      expect(warning).toHaveBeenCalledWith("跳过位于已知云同步目录的系统计划任务。");
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows explicit removal to unregister a previously protected cloud task", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-cloud-remove-schedule-test-"));
    const projectPath = path.join(directory, "cloud-project");
    await mkdir(projectPath);
    const statePath = path.join(directory, "state.json");
    const taskName = "\\SiteIndex\\cloud-project-daily";
    await writeFile(
      statePath,
      JSON.stringify({
        mode: "system",
        authorization_required: false,
        registered_task_names: [taskName],
        project_paths: { "cloud-project": projectPath },
        orphaned_tasks: [],
      }),
      "utf8",
    );
    const registrar = {
      reconcile: vi.fn(async (..._args: Parameters<WindowsTaskRegistrar["reconcile"]>) => ({
        mode: "system" as const,
        authorization_required: false,
        registered_task_names: [],
      })),
    };
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Synthetic\\SiteIndex.exe",
      runtimeStatePath: statePath,
      windowsTaskRegistrar: registrar,
      inspectStorageLocation: async () => ({ status: "known-cloud", provider: "Fixture Drive" }),
    });

    try {
      await scheduler.reconcile([], true, ["cloud-project"]);
      expect(registrar.reconcile.mock.calls[0]?.[1]).toContain(taskName);
      expect(JSON.parse(await readFile(statePath, "utf8")).registered_task_names).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips a missing project, keeps other tasks, and records denied cleanup as an orphan", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-orphan-schedule-test-"));
    const projectPath = path.join(directory, "missing-project");
    const activePath = path.join(directory, "active-project");
    await mkdir(projectPath);
    await mkdir(activePath);
    const missingName = "\\SiteIndex\\missing-project-daily";
    const activeName = "\\SiteIndex\\active-project-daily";
    const registrar = {
      reconcile: vi
        .fn()
        .mockResolvedValueOnce({
          mode: "system",
          authorization_required: false,
          registered_task_names: [missingName, activeName],
        })
        .mockResolvedValueOnce({
          mode: "system",
          authorization_required: true,
          registered_task_names: [missingName, activeName],
        }),
    };
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "unused.exe",
      runtimeStatePath: path.join(directory, "state.json"),
      windowsTaskRegistrar: registrar,
    });
    const definitions = [
      { projectId: "missing-project", projectPath, config, isThisDevice: true },
      { projectId: "active-project", projectPath: activePath, config, isThisDevice: true },
    ];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await scheduler.reconcile(definitions, false);
      await rm(projectPath, { recursive: true, force: true });
      await expect(scheduler.reconcile(definitions, false)).resolves.toEqual({
        mode: "system",
        authorization_required: true,
      });
      expect(warning).toHaveBeenCalledWith("跳过不存在的项目计划任务。", { projectId: "missing-project" });
      const desired = (registrar.reconcile.mock.calls[1]?.[0] ?? []) as ScheduleProjectDefinition[];
      expect(new Set(desired.map(({ projectId }) => projectId))).toEqual(new Set(["active-project"]));
      const state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) as {
        orphaned_tasks: { taskName: string; path: string; reason: string }[];
      };
      expect(state.orphaned_tasks).toEqual([
        { taskName: missingName, path: projectPath, reason: "项目路径不存在，且系统拒绝注销旧计划任务。" },
      ]);
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("verifies Windows task registration, path and trigger settings", async () => {
    const projectPath = tmpdir();
    const userId = "SYNTHETIC\\Tester";
    const definitions: WindowsTaskDefinition[] = (["daily", "weekly", "monthly"] as const).map((job) => ({
      projectId: "synthetic-project",
      projectPath,
      executablePath: "C:\\Synthetic\\SiteIndex.exe",
      userId,
      job,
      schedule: config[job],
      options: config.options,
    }));
    const xmlByName = new Map(
      definitions.map((definition) => [
        windowsTaskName(definition.projectId, definition.job),
        buildWindowsTaskXml(definition),
      ]),
    );
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Synthetic\\SiteIndex.exe",
      runCommand: async (_file, args) => {
        if (args.length === 0) return userId;
        const xml = xmlByName.get(args[2] ?? "");
        if (!xml) throw Object.assign(new Error("task not found"), { detail: "The task does not exist" });
        return xml;
      },
    });
    const project: ScheduleProjectDefinition = {
      projectId: "synthetic-project",
      projectPath,
      config,
      isThisDevice: true,
    };

    await expect(scheduler.verify(project)).resolves.toEqual({ state: "ok" });
    const dailyName = windowsTaskName(project.projectId, "daily");
    xmlByName.set(
      dailyName,
      buildWindowsTaskXml({ ...definitions[0]!, projectPath: path.join(tmpdir(), "old-project") }),
    );
    await expect(scheduler.verify(project)).resolves.toMatchObject({
      state: "path_mismatch",
      message: expect.stringContaining(`期望 ${projectPath}，实际 ${path.join(tmpdir(), "old-project")}`),
    });
    xmlByName.set(dailyName, buildWindowsTaskXml({ ...definitions[0]!, schedule: { ...config.daily, time: "03:00" } }));
    await expect(scheduler.verify(project)).resolves.toMatchObject({
      state: "error",
      message: expect.stringContaining("Trigger.Time：期望 02:00，实际 03:00"),
    });
    xmlByName.delete(dailyName);
    await expect(scheduler.verify(project)).resolves.toMatchObject({ state: "unregistered" });
  });

  it("verifies a real Windows XML export using synthetic project and account values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-windows-query-verify-test-"));
    const projectPath = path.join(directory, "sample-store");
    await mkdir(projectPath);
    const actualXml = (
      await readFile(new URL("./fixtures/windows-task-query.xml", import.meta.url), "utf8")
    ).replaceAll("C:\\SiteIndexFixture\\sample-store", projectPath);
    const verificationConfig: ScheduleConfig = {
      ...config,
      daily: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "17:00" },
      validate: { ...config.validate, enabled: false },
      weekly: { ...config.weekly, enabled: false },
      readme: { ...config.readme, enabled: false },
      monthly: { ...config.monthly, enabled: false },
    };
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Program Files\\SiteIndex\\SiteIndex.exe",
      runCommand: async (file, args) => {
        if (file === "whoami.exe" && args.length === 0) return "FIXTURE-PC\\tester";
        if (file === "whoami.exe") return '"FIXTURE-PC\\tester","S-1-5-21-111-222-333-1001"';
        if (file === "schtasks.exe" && args[0] === "/Query" && args[2] === windowsTaskName("sample-store", "daily")) {
          return actualXml;
        }
        throw Object.assign(new Error("task not found"), { detail: "The task does not exist" });
      },
    });

    try {
      await expect(
        scheduler.verify({ projectId: "sample-store", projectPath, config: verificationConfig, isThisDevice: true }),
      ).resolves.toEqual({ state: "ok" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports resident scheduling without querying for missing system tasks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-resident-verify-test-"));
    const projectPath = path.join(directory, "sample-store");
    const statePath = path.join(directory, "schedule-state.json");
    await mkdir(projectPath);
    await writeFile(
      statePath,
      JSON.stringify({ mode: "resident", authorization_required: true, registered_task_names: [] }),
      "utf8",
    );
    const runCommand = vi.fn(async () => "");
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "C:\\Synthetic\\SiteIndex.exe",
      runtimeStatePath: statePath,
      runCommand,
    });

    try {
      await expect(
        scheduler.verify({ projectId: "sample-store", projectPath, config, isThisDevice: true }),
      ).resolves.toEqual({ state: "ok", message: "当前为软件驻留调度，无系统任务。" });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("writes and loads macOS LaunchAgents through launchctl", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "siteindex-launchd-test-"));
    const projectPath = path.join(homeDirectory, "sample-store");
    await mkdir(projectPath);
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
      const state = await scheduler.reconcile(
        [{ projectId: "sample-store", projectPath, config: macConfig, isThisDevice: true }],
        false,
      );
      expect(state).toEqual({ mode: "system", authorization_required: false });
      expect(commands.some(({ file, args }) => file === "launchctl" && args[0] === "bootstrap")).toBe(true);
      await expect(access(path.join(homeDirectory, "Library", "LaunchAgents"))).resolves.toBeUndefined();
      await scheduler.reconcile([], false);
      expect(commands.some(({ file, args }) => file === "launchctl" && args[0] === "bootout")).toBe(true);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("leaves an existing macOS LaunchAgent untouched when its project becomes known-cloud", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "siteindex-launchd-cloud-test-"));
    const projectPath = path.join(homeDirectory, "cloud-project");
    await mkdir(projectPath);
    const commands: { file: string; args: string[] }[] = [];
    const inspectStorageLocation = vi
      .fn()
      .mockResolvedValueOnce({ status: "unknown" })
      .mockResolvedValueOnce({ status: "known-cloud", provider: "Fixture Drive" });
    const scheduler = createSystemScheduler({
      platform: "darwin",
      executablePath: macDefinition.executablePath,
      homeDirectory,
      uid: 501,
      inspectStorageLocation,
      runCommand: async (file, args) => {
        commands.push({ file, args });
        return "loaded";
      },
    });
    const project: ScheduleProjectDefinition = {
      projectId: "cloud-project",
      projectPath,
      config: {
        ...config,
        validate: { ...config.validate, enabled: false },
        weekly: { ...config.weekly, enabled: false },
        readme: { ...config.readme, enabled: false },
        monthly: { ...config.monthly, enabled: false },
      },
      isThisDevice: true,
    };

    try {
      await scheduler.reconcile([project], false);
      const plistPath = path.join(
        homeDirectory,
        "Library",
        "LaunchAgents",
        `${launchAgentLabel("cloud-project", "daily")}.plist`,
      );
      const before = await readFile(plistPath, "utf8");
      commands.length = 0;
      await scheduler.reconcile([project], false);
      expect(await readFile(plistPath, "utf8")).toBe(before);
      expect(commands.some(({ args }) => args[0] === "bootout")).toBe(false);
      expect(commands.some(({ args }) => args[0] === "bootstrap")).toBe(false);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
