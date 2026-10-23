import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { ScheduleConfig, Weekday } from "@siteindex/shared";
import { calculateNextRuns, createSystemScheduler, windowsTaskNames } from "./schedule.js";

const execFileAsync = promisify(execFile);
const runOnWindows = process.platform === "win32" && process.env.SITEINDEX_WINDOWS_SCHEDULER_E2E === "1";

function weekday(date: Date): Weekday {
  return (date.getDay() === 0 ? 7 : date.getDay()) as Weekday;
}

function timeOf(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

async function taskLastRun(projectId: string): Promise<{ lastRunTime: string; lastTaskResult: number }> {
  for (const taskName of windowsTaskNames(projectId, "daily")) {
    const nested = taskName.startsWith("\\SiteIndex\\");
    const taskLeafName = nested ? taskName.slice("\\SiteIndex\\".length) : taskName;
    const taskFolder = nested ? "\\SiteIndex" : "\\";
    const script = `$service = New-Object -ComObject Schedule.Service; $service.Connect(); $task = $service.GetFolder('${taskFolder}').GetTask('${taskLeafName}'); [pscustomobject]@{lastRunTime=$task.LastRunTime.ToString('o');lastTaskResult=$task.LastTaskResult} | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
      });
      return JSON.parse(stdout.trim()) as { lastRunTime: string; lastTaskResult: number };
    } catch {
      // 根目录兼容任务也可能是注册成功的位置。
    }
  }
  throw new Error(`找不到项目 ${projectId} 的 daily 系统计划任务。`);
}

async function queryTaskXml(projectId: string): Promise<string> {
  for (const taskName of windowsTaskNames(projectId, "daily")) {
    try {
      const { stdout } = await execFileAsync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"], {
        windowsHide: true,
      });
      return stdout;
    } catch {
      // 根目录兼容任务也可能是注册成功的位置。
    }
  }
  throw new Error(`找不到项目 ${projectId} 的 daily 系统计划任务。`);
}

it.skipIf(!runOnWindows)(
  "registers a weekday 02:00 task and verifies a scheduled Windows trigger fires",
  async () => {
    const executablePath = process.env.SITEINDEX_WINDOWS_SCHEDULER_EXE;
    expect(executablePath, "set SITEINDEX_WINDOWS_SCHEDULER_EXE to a packaged C6 SiteIndex.exe").toBeTruthy();
    const scheduler = createSystemScheduler({ executablePath: executablePath! });
    const projectRoot = await mkdtemp(path.join(tmpdir(), "siteindex-scheduler-e2e-"));
    const scheduleId = `e2e-${randomUUID()}`;
    const timedId = `${scheduleId}-timed`;
    const weekdaySet = [1, 2, 3, 4, 5] as Weekday[];
    const baseConfig: ScheduleConfig = {
      daily: { enabled: true, days: weekdaySet, time: "02:00" },
      validate: { enabled: false, days: weekdaySet, time: "03:00" },
      weekly: { enabled: false, days: [1], time: "04:00" },
      readme: { enabled: false, days: [1], time: "05:00" },
      monthly: { enabled: false, day_of_month: 1, time: "06:00" },
      options: { wake_to_run: true, run_if_missed: false, notify_on_failure: true, validate_after_sync: false },
    };

    try {
      const workdayState = await scheduler.sync(scheduleId, projectRoot, baseConfig);
      expect(workdayState.registered).toBe(true);
      const xml = await queryTaskXml(scheduleId);
      expect(xml).toContain("<StartBoundary>");
      expect(xml).toContain("<ScheduleByWeek>");
      expect(xml).toMatch(/<Friday\s*\/>/);
      expect(xml).toMatch(/T02:00:00/);
      expect(calculateNextRuns(baseConfig)[0]?.at).toBeTruthy();

      const registrationNow = new Date();
      const target = new Date(registrationNow.getTime() + 180_000);
      const targetAt = new Date(
        target.getFullYear(),
        target.getMonth(),
        target.getDate(),
        target.getHours(),
        target.getMinutes(),
        0,
        0,
      );
      const todayConfig: ScheduleConfig = {
        ...baseConfig,
        daily: { enabled: true, days: [weekday(targetAt)], time: timeOf(targetAt) },
      };
      const timedState = await scheduler.sync(timedId, projectRoot, todayConfig);
      expect(timedState.registered).toBe(true);

      const deadline = Date.now() + 5 * 60_000;
      let fired: { lastRunTime: string; lastTaskResult: number } | null = null;
      while (Date.now() < deadline) {
        const result = await taskLastRun(timedId).catch(() => null);
        const lastRun = result ? Date.parse(result.lastRunTime) : Number.NaN;
        if (result && Number.isFinite(lastRun) && lastRun >= targetAt.getTime()) {
          fired = result;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      }
      expect(fired, `Windows Task Scheduler did not record a trigger at ${targetAt.toISOString()}`).not.toBeNull();
      expect(fired?.lastTaskResult).toBe(5); // 临时项目未认领，打包程序应由 core 返回 NOT_RUNNER。
    } finally {
      await scheduler.removeProject(scheduleId).catch(() => undefined);
      await scheduler.removeProject(timedId).catch(() => undefined);
      await rm(projectRoot, { recursive: true, force: true });
    }
  },
  360_000,
);
