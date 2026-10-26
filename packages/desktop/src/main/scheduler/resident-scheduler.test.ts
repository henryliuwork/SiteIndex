import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectId, ScheduleConfig } from "@siteindex/shared";
import { createResidentScheduler } from "./resident-scheduler.js";

const config: ScheduleConfig = {
  daily: { enabled: true, days: [1, 2, 3, 4, 5], time: "02:00" },
  validate: { enabled: false, days: [1, 2, 3, 4, 5], time: "03:00" },
  weekly: { enabled: true, days: [1], time: "04:30" },
  readme: { enabled: false, days: [1], time: "05:00" },
  monthly: { enabled: true, day_of_month: 15, time: "06:15" },
  options: { wake_to_run: false, run_if_missed: true, notify_on_failure: true, validate_after_sync: false },
};

describe("resident Windows scheduler", () => {
  it("runs a due weekday job once and persists its occurrence across restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-resident-scheduler-"));
    const statePath = path.join(directory, "schedule-state.json");
    const runJob = vi.fn(async () => undefined);
    const project = { id: "sample-store" as ProjectId, path: path.join(directory, "sample-store") };
    const options = {
      statePath,
      now: () => new Date(2026, 9, 26, 2, 0, 0),
      listProjects: async () => [project],
      getSchedule: async () => config,
      isThisDevice: async () => true,
      isJobRunning: async () => false,
      runJob,
    };

    try {
      const scheduler = createResidentScheduler(options);
      await scheduler.runDue();
      await scheduler.runDue();
      expect(runJob).toHaveBeenCalledTimes(1);
      expect(runJob).toHaveBeenCalledWith(project, "daily");

      const restartedScheduler = createResidentScheduler(options);
      await restartedScheduler.runDue();
      expect(runJob).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not run jobs on projects assigned to another device", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-resident-scheduler-"));
    const runJob = vi.fn(async () => undefined);
    const scheduler = createResidentScheduler({
      statePath: path.join(directory, "schedule-state.json"),
      now: () => new Date(2026, 9, 26, 2, 0, 0),
      listProjects: async () => [{ id: "sample-store" as ProjectId, path: directory }],
      getSchedule: async () => config,
      isThisDevice: async () => false,
      isJobRunning: async () => false,
      runJob,
    });

    try {
      await scheduler.runDue();
      expect(runJob).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32" || process.env.SITEINDEX_RESIDENT_SCHEDULER_E2E !== "1")(
    "fires a weekday schedule in the logged-in Windows process",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "siteindex-resident-scheduler-e2e-"));
      const target = new Date(Date.now() + 65_000);
      target.setSeconds(0, 0);
      const weekday = (target.getDay() === 0 ? 7 : target.getDay()) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
      const scheduledConfig: ScheduleConfig = {
        ...config,
        daily: {
          enabled: true,
          days: [weekday],
          time: `${target.getHours().toString().padStart(2, "0")}:${target.getMinutes().toString().padStart(2, "0")}`,
        },
        validate: { ...config.validate, enabled: false },
        weekly: { ...config.weekly, enabled: false },
        readme: { ...config.readme, enabled: false },
        monthly: { ...config.monthly, enabled: false },
        options: { ...config.options, run_if_missed: false },
      };
      const runJob = vi.fn(async () => undefined);
      const scheduler = createResidentScheduler({
        statePath: path.join(directory, "schedule-state.json"),
        intervalMs: 250,
        listProjects: async () => [{ id: "windows-smoke" as ProjectId, path: directory }],
        getSchedule: async () => scheduledConfig,
        isThisDevice: async () => true,
        isJobRunning: async () => false,
        runJob,
      });
      const timeout = target.getTime() + 10_000;

      try {
        scheduler.start();
        while (Date.now() < timeout && runJob.mock.calls.length === 0) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
        expect(runJob).toHaveBeenCalledTimes(1);
        expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ id: "windows-smoke" }), "daily");
      } finally {
        scheduler.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
    140_000,
  );
});
