import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchAgentPlist,
  calculateNextRuns,
  createSystemScheduler,
  scheduledOccurrenceKey,
  type LaunchAgentDefinition,
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
      await scheduler.reconcile(
        [{ projectId: "sample-store", projectPath: "C:\\Users\\Tester\\sample-store", config, isThisDevice: true }],
        false,
      );
      await expect(
        scheduler.getState("sample-store", "C:\\Users\\Tester\\sample-store", config),
      ).resolves.toMatchObject({
        registered: true,
      });
      await expect(scheduler.getRuntimeStatus()).resolves.toEqual({ mode: "system", authorization_required: false });
      expect(registrar.reconcile).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      const state = await scheduler.reconcile(
        [{ projectId: "sample-store", projectPath: macDefinition.projectPath, config: macConfig, isThisDevice: true }],
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
});
