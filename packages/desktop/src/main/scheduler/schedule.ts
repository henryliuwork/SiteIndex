import type { JobSchedule, ScheduleConfig, ScheduleState, Weekday } from "@siteindex/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  createWindowsTaskRegistrar,
  windowsRootTaskName,
  windowsTaskName,
  WINDOWS_SCHEDULED_JOBS,
  type WindowsTaskDefinition,
  type WindowsTaskRegistrar,
} from "./windows-tasks.js";

export { buildWindowsTaskXml, windowsRootTaskName, windowsTaskName } from "./windows-tasks.js";

export const SCHEDULED_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export interface LaunchAgentDefinition {
  projectId: string;
  projectPath: string;
  executablePath: string;
  job: ScheduledJob;
  schedule: JobSchedule;
}

export interface SystemScheduler {
  getState(projectId: string, projectPath: string, config: ScheduleConfig): Promise<ScheduleState>;
  getRuntimeStatus(): Promise<ScheduleRuntimeStatus>;
  reconcile(projects: ScheduleProjectDefinition[], allowElevation: boolean): Promise<ScheduleRuntimeStatus>;
  reauthorize(projects: ScheduleProjectDefinition[]): Promise<ScheduleRuntimeStatus>;
}

export interface ScheduleRuntimeStatus {
  mode: "system" | "resident";
  authorization_required: boolean;
}

export interface ScheduleProjectDefinition {
  projectId: string;
  projectPath: string;
  config: ScheduleConfig;
  isThisDevice: boolean;
}

interface PersistedWindowsScheduleState extends ScheduleRuntimeStatus {
  registered_task_names: string[];
}

const LAUNCHD_WEEKDAYS: Record<Weekday, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 0,
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapePlist(value: string): string {
  return escapeXml(value);
}

function assertSafeProjectId(projectId: string): void {
  if (!projectId || /[\\/\0\r\n]/.test(projectId)) throw new Error("项目标识不能包含路径分隔符。");
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`无效的计划时间：${time}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`无效的计划时间：${time}`);
  return { hour, minute };
}

function selectedWeekdays(schedule: JobSchedule): Weekday[] {
  const days = [...new Set(schedule.days ?? [])].sort((left, right) => left - right);
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("启用的每周计划必须选择有效的星期。");
  }
  return days;
}

function localDate(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function launchAgentLabel(projectId: string, job: ScheduledJob): string {
  assertSafeProjectId(projectId);
  const safeId =
    projectId
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const suffix = createHash("sha256").update(projectId).digest("hex").slice(0, 8);
  return `com.siteindex.${safeId}.${suffix}.${job}`;
}

function launchdInterval(job: ScheduledJob, schedule: JobSchedule): string {
  const { hour, minute } = parseTime(schedule.time);
  if (job === "monthly") {
    const day = schedule.day_of_month;
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) {
      throw new Error("每月计划必须选择 1 至 31 日。");
    }
    return `<dict><key>Day</key><integer>${day}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  }
  return selectedWeekdays(schedule)
    .map(
      (weekday) =>
        `<dict><key>Weekday</key><integer>${LAUNCHD_WEEKDAYS[weekday]}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
    )
    .join("");
}

export function buildLaunchAgentPlist(definition: LaunchAgentDefinition): string {
  const label = launchAgentLabel(definition.projectId, definition.job);
  const args = [definition.executablePath, "--run-job", definition.projectPath, definition.job];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapePlist(label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapePlist(arg)}</string>`).join("")}</array>
  <key>StartCalendarInterval</key><array>${launchdInterval(definition.job, definition.schedule)}</array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function nextRunFor(job: ScheduledJob, schedule: JobSchedule, now: Date): string | null {
  if (!schedule.enabled) return null;
  const { hour, minute } = parseTime(schedule.time);
  const weekdays = job === "monthly" ? [] : selectedWeekdays(schedule);
  if (
    job === "monthly" &&
    (!Number.isInteger(schedule.day_of_month) || schedule.day_of_month! < 1 || schedule.day_of_month! > 31)
  ) {
    throw new Error("每月计划必须选择 1 至 31 日。");
  }
  for (let offset = 0; offset < 370; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0);
    if (job === "monthly" && date.getDate() !== schedule.day_of_month) continue;
    if (job !== "monthly" && !weekdays.includes((date.getDay() === 0 ? 7 : date.getDay()) as Weekday)) continue;
    if (date.getTime() > now.getTime()) return date.toISOString();
  }
  return null;
}

export function calculateNextRuns(config: ScheduleConfig, now = new Date()): ScheduleState["next_runs"] {
  return SCHEDULED_JOBS.map((job) => ({ job, at: nextRunFor(job, config[job], now) }));
}

export function scheduledOccurrenceKey(job: ScheduledJob, config: ScheduleConfig, now: Date): string | null {
  const schedule = jobDefinition(config, job);
  if (!schedule.enabled) return null;
  const { hour, minute } = parseTime(schedule.time);
  if (job === "monthly") {
    if (!Number.isInteger(schedule.day_of_month) || now.getDate() !== schedule.day_of_month) return null;
  } else if (!selectedWeekdays(schedule).includes((now.getDay() === 0 ? 7 : now.getDay()) as Weekday)) {
    return null;
  }

  const scheduledAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (now.getTime() < scheduledAt.getTime()) return null;
  if (!config.options.run_if_missed && now.getTime() - scheduledAt.getTime() >= 60_000) return null;
  return `${localDate(now)}T${schedule.time}`;
}

function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        const detail = [stdout, (error as Error & { stderr?: string }).stderr].filter(Boolean).join("\n");
        const code = (error as Error & { code?: number | string }).code;
        reject(Object.assign(new Error(`${file} 执行失败。`), { detail, cause: error, code }));
      } else resolve(stdout);
    });
  });
}

function jobDefinition(config: ScheduleConfig, job: ScheduledJob): JobSchedule {
  return config[job];
}

export function createSystemScheduler(options: {
  platform?: NodeJS.Platform;
  executablePath: string;
  homeDirectory?: string;
  uid?: number;
  runtimeStatePath?: string;
  runCommand?: (file: string, args: string[]) => Promise<string>;
  windowsTaskRegistrar?: WindowsTaskRegistrar;
  beforeElevation?: () => Promise<void>;
}): SystemScheduler {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? execute;
  const homeDirectory = options.homeDirectory ?? homedir();
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const agentDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
  const windowsTaskRegistrar =
    options.windowsTaskRegistrar ??
    createWindowsTaskRegistrar({ runCommand, beforeElevation: options.beforeElevation });
  const runtimeState: PersistedWindowsScheduleState = {
    mode: "system",
    authorization_required: false,
    registered_task_names: [],
  };
  let macProjectIds = new Set<string>();

  function plistPath(projectId: string, job: ScheduledJob): string {
    return path.join(agentDirectory, `${launchAgentLabel(projectId, job)}.plist`);
  }

  async function loadRuntimeState(): Promise<PersistedWindowsScheduleState> {
    if (!options.runtimeStatePath) return runtimeState;
    try {
      const value: unknown = JSON.parse(await readFile(options.runtimeStatePath, "utf8"));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const state = value as Record<string, unknown>;
        if (
          (state.mode === "system" || state.mode === "resident") &&
          typeof state.authorization_required === "boolean" &&
          Array.isArray(state.registered_task_names) &&
          state.registered_task_names.every((name) => typeof name === "string")
        ) {
          Object.assign(runtimeState, {
            mode: state.mode,
            authorization_required: state.authorization_required,
            registered_task_names: state.registered_task_names,
          });
        }
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        console.warn("读取计划任务状态失败，将重新校正计划。", error);
      }
    }
    return runtimeState;
  }

  async function saveRuntimeState(value: PersistedWindowsScheduleState): Promise<void> {
    Object.assign(runtimeState, value);
    if (!options.runtimeStatePath) return;
    await mkdir(path.dirname(options.runtimeStatePath), { recursive: true });
    const temporaryPath = `${options.runtimeStatePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, options.runtimeStatePath);
  }

  async function removeMac(projectId: string, job: ScheduledJob): Promise<void> {
    const label = launchAgentLabel(projectId, job);
    const filePath = plistPath(projectId, job);
    try {
      await runCommand("launchctl", ["bootout", `gui/${uid}`, filePath]);
    } catch {
      // 未加载的任务不妨碍删除本地 plist。
    }
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    try {
      await runCommand("launchctl", ["remove", label]);
    } catch {
      // launchctl remove 对已经卸载的 label 会返回非零。
    }
  }

  async function registerMac(project: ScheduleProjectDefinition): Promise<void> {
    await mkdir(agentDirectory, { recursive: true });
    for (const job of SCHEDULED_JOBS) {
      const schedule = jobDefinition(project.config, job);
      if (!project.isThisDevice || !schedule.enabled) {
        await removeMac(project.projectId, job);
        continue;
      }
      const label = launchAgentLabel(project.projectId, job);
      const filePath = plistPath(project.projectId, job);
      const content = buildLaunchAgentPlist({
        projectId: project.projectId,
        projectPath: project.projectPath,
        executablePath: options.executablePath,
        job,
        schedule,
      });
      await runCommand("launchctl", ["bootout", `gui/${uid}`, filePath]).catch(() => undefined);
      await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
      await runCommand("launchctl", ["bootstrap", `gui/${uid}`, filePath]);
    }
  }

  async function isMacRegistered(projectId: string, job: ScheduledJob): Promise<boolean> {
    try {
      await access(plistPath(projectId, job));
      await runCommand("launchctl", ["print", `gui/${uid}/${launchAgentLabel(projectId, job)}`]);
      return true;
    } catch {
      return false;
    }
  }

  async function getRuntimeStatus(): Promise<ScheduleRuntimeStatus> {
    if (platform !== "win32") return { mode: "system", authorization_required: false };
    const state = await loadRuntimeState();
    return { mode: state.mode, authorization_required: state.authorization_required };
  }

  async function reconcile(
    projects: ScheduleProjectDefinition[],
    allowElevation: boolean,
  ): Promise<ScheduleRuntimeStatus> {
    if (platform === "win32") {
      const state = await loadRuntimeState();
      const desired: WindowsTaskDefinition[] = [];
      const obsoleteNames: string[] = [];
      for (const project of projects) {
        assertSafeProjectId(project.projectId);
        for (const job of WINDOWS_SCHEDULED_JOBS) {
          const nestedName = windowsTaskName(project.projectId, job);
          const rootName = windowsRootTaskName(project.projectId, job);
          obsoleteNames.push(nestedName, rootName);
          const schedule = project.config[job];
          if (!project.isThisDevice || !schedule.enabled) continue;
          desired.push({
            projectId: project.projectId,
            projectPath: project.projectPath,
            executablePath: options.executablePath,
            userId: "",
            job,
            schedule,
            options: project.config.options,
          });
        }
      }
      const result = await windowsTaskRegistrar.reconcile(
        desired,
        obsoleteNames.filter(
          (name) => !desired.some((definition) => windowsTaskName(definition.projectId, definition.job) === name),
        ),
        state.registered_task_names,
        allowElevation,
        state.mode,
      );
      const nextState: PersistedWindowsScheduleState = {
        mode: result.mode,
        authorization_required: result.authorization_required,
        registered_task_names: result.registered_task_names,
      };
      await saveRuntimeState(nextState);
      return { mode: nextState.mode, authorization_required: nextState.authorization_required };
    }

    if (platform === "darwin") {
      const currentIds = new Set(projects.map(({ projectId }) => projectId));
      for (const staleId of macProjectIds) {
        if (currentIds.has(staleId)) continue;
        for (const job of SCHEDULED_JOBS) await removeMac(staleId, job);
      }
      for (const project of projects) await registerMac(project);
      macProjectIds = currentIds;
    }
    return { mode: "system", authorization_required: false };
  }

  return {
    async getState(projectId, _projectPath, config) {
      if (platform === "win32") {
        const state = await loadRuntimeState();
        const enabledNames = WINDOWS_SCHEDULED_JOBS.filter((job) => config[job].enabled).map((job) =>
          windowsTaskName(projectId, job),
        );
        return {
          config,
          registered:
            state.mode === "system" && enabledNames.every((name) => state.registered_task_names.includes(name)),
          next_runs: calculateNextRuns(config),
        };
      }
      const checks =
        platform === "darwin"
          ? await Promise.all(
              SCHEDULED_JOBS.filter((job) => config[job].enabled).map((job) => isMacRegistered(projectId, job)),
            )
          : [];
      return {
        config,
        registered: platform === "darwin" ? checks.every(Boolean) : false,
        next_runs: calculateNextRuns(config),
      };
    },
    getRuntimeStatus,
    reconcile,
    reauthorize(projects) {
      return reconcile(projects, true);
    },
  };
}
