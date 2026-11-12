import type { JobSchedule, ScheduleConfig, ScheduleState, SystemTaskRow, Weekday } from "@siteindex/shared";
import { inspectProjectStorageLocation } from "@siteindex/core";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import type { AddExistingTimingCallback } from "../add-existing-trace.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  createWindowsTaskRegistrar,
  windowsRootTaskName,
  windowsTaskName,
  windowsTaskDifferences,
  windowsTaskUserId,
  inspectWindowsTaskXml,
  parseWindowsUserSid,
  isWindowsUserSid,
  isWindowsTaskMissing,
  parseWindowsTaskNamesCsv,
  parseWindowsTaskRuntimeCsv,
  WINDOWS_SCHEDULED_JOBS,
  type WindowsTaskDefinition,
  type WindowsTaskRegistrar,
} from "./windows-tasks.js";

export { buildWindowsTaskXml, windowsRootTaskName, windowsTaskName } from "./windows-tasks.js";

export const SCHEDULED_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];
type XmlElement = NonNullable<ReturnType<DOMParser["parseFromString"]>["documentElement"]>;

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
  verify(project: ScheduleProjectDefinition): Promise<ScheduleVerification>;
  listOrphans(projects: { projectPath: string }[]): Promise<{ taskName: string; path: string; reason: string }[]>;
  removeOrphan(taskName: string): Promise<void>;
  listSystemTasks(projects: SystemTaskProjectDefinition[]): Promise<SystemTaskRow[]>;
  reconcile(
    projects: ScheduleProjectDefinition[],
    allowElevation: boolean,
    removedProjectIds?: string[],
    onTiming?: AddExistingTimingCallback,
  ): Promise<ScheduleRuntimeStatus>;
  reauthorize(projects: ScheduleProjectDefinition[]): Promise<ScheduleRuntimeStatus>;
}

export interface ScheduleVerification {
  state: "ok" | "unregistered" | "path_mismatch" | "orphaned" | "error";
  message?: string;
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

export interface SystemTaskProjectDefinition {
  projectId: string;
  projectPath: string;
  config: ScheduleConfig | null;
}

interface PersistedWindowsScheduleState extends ScheduleRuntimeStatus {
  registered_task_names: string[];
  project_paths: Record<string, string>;
  orphaned_tasks: { taskName: string; path: string; reason: string }[];
  mac_project_paths?: Record<string, string>;
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

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isSiteIndexTaskName(taskName: string): boolean {
  return taskName.replace(/^\\+/, "").toLowerCase().startsWith("siteindex");
}

export { parseWindowsTaskNamesCsv } from "./windows-tasks.js";

function pathKey(value: string): string {
  const normalized = path.win32.resolve(value);
  return normalized.toLowerCase();
}

function taskIdentity(taskName: string): string | null {
  const parsed = parseWindowsTaskName(taskName);
  return parsed ? `${parsed.projectId.toLowerCase()}-${parsed.job}` : null;
}

function parseWindowsTaskName(taskName: string): { projectId: string; job: ScheduledJob } | null {
  const normalized = taskName.replace(/^\\+/, "");
  const lower = normalized.toLowerCase();
  const suffix = lower.startsWith("siteindex\\")
    ? normalized.slice("siteindex\\".length)
    : lower.startsWith("siteindex - ")
      ? normalized.slice("siteindex - ".length)
      : null;
  if (suffix === null) return null;
  for (const job of SCHEDULED_JOBS) {
    const ending = `-${job}`;
    if (suffix.toLowerCase().endsWith(ending)) return { projectId: suffix.slice(0, -ending.length), job };
  }
  return null;
}

function sameProjectPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
  return path.resolve(left) === path.resolve(right);
}

function normalizeTaskDateTime(value: string | null): string | null {
  const raw = value?.trim();
  if (!raw || /^(n\/a|never|not yet run|none)$/i.test(raw)) return null;
  const localized = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(上午|下午)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (localized) {
    const [, year, month, day, period, rawHour, minute, second = "0"] = localized;
    const hour = (Number(rawHour) % 12) + (period === "下午" ? 12 : 0);
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function windowsTriggerSummary(trigger: ReturnType<typeof inspectWindowsTaskXml>["trigger"]): string {
  if (!trigger) return "未识别触发器";
  const time = trigger.startTime ?? "时间未知";
  if (trigger.kind === "monthly") return `每月 ${trigger.monthDays.join("、") || "日期未知"} 日 ${time}`;
  if (trigger.kind === "weekly") {
    const days: Record<string, string> = {
      Monday: "一",
      Tuesday: "二",
      Wednesday: "三",
      Thursday: "四",
      Friday: "五",
      Saturday: "六",
      Sunday: "日",
    };
    const ordered = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
      .filter((day) => trigger.weekdays.includes(day))
      .map((day) => days[day]);
    return `每周 ${ordered.length > 0 ? ordered.join("、") : "日期未知"} ${time}`;
  }
  return `未知频率 ${time}`;
}

interface LaunchCalendarInterval {
  day: number | null;
  weekday: number | null;
  hour: number | null;
  minute: number | null;
}

interface ParsedLaunchAgent {
  label: string | null;
  programArguments: string[];
  intervals: LaunchCalendarInterval[];
  runAtLoad: boolean | null;
}

function parseLaunchAgentPlist(xml: string): ParsedLaunchAgent {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") errors.push(message);
    },
  }).parseFromString(xml.replace(/^\uFEFF/, ""), "application/xml");
  const root = document.documentElement;
  const rootDict =
    root?.localName === "plist" ? Array.from(root.children).find((child) => child.localName === "dict") : null;
  if (errors.length || !rootDict) throw new Error(errors[0] ?? "plist 根元素无效。");

  const dictValue = (dict: XmlElement, key: string): XmlElement | null => {
    const children = Array.from(dict.children);
    for (let index = 0; index < children.length - 1; index += 1) {
      if (children[index]?.localName === "key" && children[index]?.textContent === key)
        return children[index + 1] ?? null;
    }
    return null;
  };
  const textValue = (dict: XmlElement, key: string): string | null => dictValue(dict, key)?.textContent?.trim() || null;
  const numberValue = (dict: XmlElement, key: string): number | null => {
    const value = textValue(dict, key);
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const programArguments = Array.from(dictValue(rootDict, "ProgramArguments")?.children ?? [])
    .filter((element) => element.localName === "string")
    .map((element) => element.textContent ?? "");
  const intervalArray = dictValue(rootDict, "StartCalendarInterval");
  const intervals = Array.from(intervalArray?.children ?? [])
    .filter((element) => element.localName === "dict")
    .map((dict) => ({
      day: numberValue(dict, "Day"),
      weekday: numberValue(dict, "Weekday"),
      hour: numberValue(dict, "Hour"),
      minute: numberValue(dict, "Minute"),
    }));
  const runAtLoadElement = dictValue(rootDict, "RunAtLoad");
  const runAtLoad =
    runAtLoadElement?.localName === "true" ? true : runAtLoadElement?.localName === "false" ? false : null;
  return { label: textValue(rootDict, "Label"), programArguments, intervals, runAtLoad };
}

function launchIntervalsSchedule(job: ScheduledJob, intervals: LaunchCalendarInterval[]): JobSchedule | null {
  const first = intervals[0];
  if (!first || first.hour === null || first.minute === null) return null;
  const time = `${String(first.hour).padStart(2, "0")}:${String(first.minute).padStart(2, "0")}`;
  if (job === "monthly") {
    if (first.day === null) return null;
    return { enabled: true, day_of_month: first.day, time };
  }
  const days = [
    ...new Set(intervals.flatMap(({ weekday }) => (weekday === null ? [] : [weekday === 0 ? 7 : weekday]))),
  ].sort((left, right) => left - right) as Weekday[];
  return days.length ? { enabled: true, days, time } : null;
}

function launchTriggerSummary(job: ScheduledJob, intervals: LaunchCalendarInterval[]): string {
  const schedule = launchIntervalsSchedule(job, intervals);
  if (!schedule) return "未识别触发器";
  if (job === "monthly") return `每月 ${schedule.day_of_month} 日 ${schedule.time}`;
  const labels = ["一", "二", "三", "四", "五", "六", "日"];
  return `每周 ${schedule.days?.map((day) => labels[day - 1]).join("、")} ${schedule.time}`;
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

export function projectPathFromWindowsTaskXml(xml: string): string | null {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/i.exec(xml)?.[1];
  if (!args) return null;
  const decoded = args
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  return /--run-job\s+"([^"]+)"/i.exec(decoded)?.[1] ?? null;
}

function projectIdFromTaskName(taskName: string): string | null {
  const normalized = taskName.replace(/^\\+/, "");
  const lower = normalized.toLowerCase();
  const prefix = lower.startsWith("siteindex\\")
    ? normalized.slice(0, "siteindex\\".length)
    : lower.startsWith("siteindex - ")
      ? normalized.slice(0, "siteindex - ".length)
      : null;
  if (!prefix) return null;
  const suffix = normalized.slice(prefix.length);
  for (const job of WINDOWS_SCHEDULED_JOBS) {
    const ending = `-${job}`;
    if (suffix.toLowerCase().endsWith(ending)) return suffix.slice(0, -ending.length);
  }
  return null;
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
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
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
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
  /** Test seam; production uses Core's best-effort known-cloud classifier. */
  inspectStorageLocation?: typeof inspectProjectStorageLocation;
}): SystemScheduler {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? execute;
  const homeDirectory = options.homeDirectory ?? homedir();
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const agentDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
  const windowsTaskRegistrar =
    options.windowsTaskRegistrar ??
    createWindowsTaskRegistrar({ runCommand, beforeElevation: options.beforeElevation });
  const inspectStorageLocation = options.inspectStorageLocation ?? inspectProjectStorageLocation;
  const runtimeState: PersistedWindowsScheduleState = {
    mode: "system",
    authorization_required: false,
    registered_task_names: [],
    project_paths: {},
    orphaned_tasks: [],
    mac_project_paths: {},
  };
  let macProjectPaths = new Map<string, string>();

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
          const projectPaths =
            typeof state.project_paths === "object" &&
            state.project_paths !== null &&
            !Array.isArray(state.project_paths)
              ? Object.fromEntries(
                  Object.entries(state.project_paths).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                )
              : {};
          const orphanedTasks = Array.isArray(state.orphaned_tasks)
            ? state.orphaned_tasks.filter(
                (task): task is PersistedWindowsScheduleState["orphaned_tasks"][number] =>
                  typeof task === "object" &&
                  task !== null &&
                  "taskName" in task &&
                  typeof task.taskName === "string" &&
                  "path" in task &&
                  typeof task.path === "string" &&
                  "reason" in task &&
                  typeof task.reason === "string",
              )
            : [];
          const macProjectPaths =
            typeof state.mac_project_paths === "object" &&
            state.mac_project_paths !== null &&
            !Array.isArray(state.mac_project_paths)
              ? Object.fromEntries(
                  Object.entries(state.mac_project_paths).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                )
              : {};
          Object.assign(runtimeState, {
            mode: state.mode,
            authorization_required: state.authorization_required,
            registered_task_names: state.registered_task_names,
            project_paths: projectPaths,
            orphaned_tasks: orphanedTasks,
            mac_project_paths: macProjectPaths,
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

  async function verify(project: ScheduleProjectDefinition): Promise<ScheduleVerification> {
    try {
      if (!(await stat(project.projectPath)).isDirectory()) {
        return { state: "orphaned", message: "项目目录不存在，计划任务可能仍指向旧路径。" };
      }
      if (platform === "win32") {
        const runtimeStatus = await getRuntimeStatus();
        if (runtimeStatus.mode === "resident") {
          return { state: "ok", message: "当前为软件驻留调度，无系统任务。" };
        }
        const userId = (await runCommand("whoami.exe", [])).trim();
        let currentSid: Promise<string | null> | null = null;
        for (const job of WINDOWS_SCHEDULED_JOBS) {
          const expected = project.isThisDevice && project.config[job].enabled;
          const names = [windowsTaskName(project.projectId, job), windowsRootTaskName(project.projectId, job)];
          let foundXml: string | null = null;
          for (const name of names) {
            try {
              foundXml = await runCommand("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
              break;
            } catch (error) {
              if (!isWindowsTaskMissing(error)) {
                return {
                  state: "error",
                  message: `读取计划任务失败：${error instanceof Error ? error.message : String(error)}`,
                };
              }
            }
          }
          if (!foundXml) {
            if (expected) return { state: "unregistered", message: `${job} 任务：期望存在系统计划任务，实际缺失。` };
            continue;
          }
          if (!expected) return { state: "error", message: `禁用的 ${job} 计划任务仍然存在。` };
          const actualPath = projectPathFromWindowsTaskXml(foundXml);
          if (!actualPath || !sameWindowsPath(actualPath, project.projectPath)) {
            return {
              state: "path_mismatch",
              message: `${job} 任务项目路径不一致：期望 ${project.projectPath}，实际 ${actualPath ?? "<缺失>"}。`,
            };
          }
          const taskUserId = windowsTaskUserId(foundXml);
          let userSid: string | undefined;
          if (isWindowsUserSid(taskUserId)) {
            currentSid ??= runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then(parseWindowsUserSid);
            userSid = (await currentSid) ?? undefined;
          }
          const definition: WindowsTaskDefinition = {
            projectId: project.projectId,
            projectPath: project.projectPath,
            executablePath: options.executablePath,
            userId,
            userSid,
            job,
            schedule: project.config[job],
            options: project.config.options,
          };
          const differences = windowsTaskDifferences(foundXml, definition);
          if (differences.length > 0) {
            const details = differences
              .map(({ field, expected, actual }) => `${field}：期望 ${expected}，实际 ${actual}`)
              .join("；");
            return { state: "error", message: `${job} 任务配置不一致：${details}。` };
          }
        }
        return { state: "ok" };
      }
      if (platform === "darwin") {
        for (const job of SCHEDULED_JOBS) {
          const expected = project.isThisDevice && project.config[job].enabled;
          const filePath = plistPath(project.projectId, job);
          let content: string;
          try {
            content = await readFile(filePath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              if (expected) return { state: "unregistered", message: `缺少 ${job} launchd 任务。` };
              continue;
            }
            throw error;
          }
          if (!expected) return { state: "error", message: `禁用的 ${job} launchd 任务仍然存在。` };
          if (!content.includes(`<string>${escapePlist(project.projectPath)}</string>`)) {
            return { state: "path_mismatch", message: `${job} launchd 任务使用的项目路径与当前路径不一致。` };
          }
          const expectedContent = buildLaunchAgentPlist({
            projectId: project.projectId,
            projectPath: project.projectPath,
            executablePath: options.executablePath,
            job,
            schedule: project.config[job],
          });
          if (content !== expectedContent || !(await isMacRegistered(project.projectId, job))) {
            return { state: "error", message: `${job} launchd 任务未加载或触发配置不一致。` };
          }
        }
        return { state: "ok" };
      }
      return { state: "error", message: "当前平台不支持计划任务核验。" };
    } catch (error) {
      return { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async function listWindowsSystemTasks(projects: SystemTaskProjectDefinition[]): Promise<SystemTaskRow[]> {
    const output = await runCommand("schtasks.exe", ["/Query", "/FO", "CSV", "/V", "/NH"]);
    const projectById = new Map(projects.map((project) => [project.projectId.toLowerCase(), project]));
    const runtimeRows = parseWindowsTaskRuntimeCsv(output);
    return mapWithConcurrency(runtimeRows, 4, async (runtime): Promise<SystemTaskRow | null> => {
      let xml: string | null = null;
      let inspection: ReturnType<typeof inspectWindowsTaskXml> | null = null;
      let xmlError: string | null = null;
      try {
        xml = await runCommand("schtasks.exe", ["/Query", "/TN", runtime.taskName, "/XML"]);
        inspection = inspectWindowsTaskXml(xml);
      } catch (error) {
        xmlError = error instanceof Error ? error.message : String(error);
      }
      const namedTask = parseWindowsTaskName(runtime.taskName);
      const argsMatch = inspection?.arguments
        ? /--run-job\s+(?:"([^"]+)"|(\S+))\s+([a-z-]+)/i.exec(inspection.arguments)
        : null;
      const taskPath = argsMatch?.[1] ?? argsMatch?.[2] ?? null;
      const argumentJob = SCHEDULED_JOBS.find((job) => job === argsMatch?.[3]?.toLowerCase());
      const job = namedTask?.job ?? argumentJob;
      if (!job) return null;
      const project =
        (namedTask ? projectById.get(namedTask.projectId.toLowerCase()) : undefined) ??
        (taskPath ? projects.find((entry) => sameProjectPath(entry.projectPath, taskPath, platform)) : undefined) ??
        null;
      const differences: string[] = [];
      if (!inspection || !xml) {
        differences.push(`无法读取任务 XML${xmlError ? `：${xmlError}` : "。"}`);
      } else if (!project) {
        differences.push("任务未关联到当前登记项目。");
      } else if (!project.config) {
        differences.push("无法读取项目计划配置。");
      } else if (!project.config[job].enabled) {
        differences.push("项目配置已停用此任务，但系统任务仍存在。");
      } else {
        const definition: WindowsTaskDefinition = {
          projectId: project.projectId,
          projectPath: project.projectPath,
          executablePath: inspection.commandPath ?? options.executablePath,
          userId: windowsTaskUserId(xml) ?? "",
          job,
          schedule: project.config[job],
          options: project.config.options,
        };
        for (const difference of windowsTaskDifferences(xml, definition)) {
          if (["UserId", "LogonType", "RunLevel", "Command"].includes(difference.field)) continue;
          differences.push(`${difference.field}：期望 ${difference.expected}，实际 ${difference.actual}`);
        }
      }
      const rawStatus = runtime.status?.toLowerCase() ?? "";
      const systemState: SystemTaskRow["systemState"] =
        rawStatus.includes("disabled") || rawStatus.includes("禁用")
          ? "Disabled"
          : rawStatus.includes("running") || rawStatus.includes("运行")
            ? "Running"
            : "Ready";
      return {
        taskName: runtime.taskName,
        projectId: project?.projectId ?? null,
        orphaned: project === null,
        job,
        systemState,
        lastRunAt: normalizeTaskDateTime(runtime.lastRunTime),
        lastResult: runtime.lastResult,
        nextRunAt: normalizeTaskDateTime(runtime.nextRunTime),
        triggerSummary: inspection ? windowsTriggerSummary(inspection.trigger) : "无法读取触发器",
        commandPath: inspection?.commandPath ?? null,
        configMatches: project?.config ? differences.length === 0 : null,
        differences,
      };
    }).then((rows) =>
      rows
        .filter((row): row is SystemTaskRow => row !== null)
        .sort((left, right) => {
          const leftName = left.taskName.toLowerCase();
          const rightName = right.taskName.toLowerCase();
          return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
        }),
    );
  }

  async function listMacSystemTasks(projects: SystemTaskProjectDefinition[]): Promise<SystemTaskRow[]> {
    let files: string[];
    try {
      files = await readdir(agentDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const plistFiles = files.filter(
      (file) => file.toLowerCase().startsWith("com.siteindex.") && file.toLowerCase().endsWith(".plist"),
    );
    return mapWithConcurrency(plistFiles, 4, async (fileName): Promise<SystemTaskRow | null> => {
      const taskName = fileName.slice(0, -".plist".length);
      let parsed: ParsedLaunchAgent | null = null;
      let plistError: string | null = null;
      try {
        parsed = parseLaunchAgentPlist(await readFile(path.join(agentDirectory, fileName), "utf8"));
      } catch (error) {
        plistError = error instanceof Error ? error.message : String(error);
      }
      const label = parsed?.label ?? taskName;
      const job = SCHEDULED_JOBS.find((candidate) => label.toLowerCase().endsWith(`.${candidate}`));
      if (!job) return null;
      const taskPath = parsed?.programArguments[2] ?? null;
      const projectByLabel = projects.find((entry) => launchAgentLabel(entry.projectId, job) === label);
      const project =
        projectByLabel ??
        (taskPath ? projects.find((entry) => sameProjectPath(entry.projectPath, taskPath, platform)) : undefined) ??
        null;
      let launchOutput = "";
      let loaded = false;
      try {
        launchOutput = await runCommand("launchctl", ["print", `gui/${uid}/${label}`]);
        loaded = true;
      } catch {
        // plist 可能留在磁盘但尚未由 launchd 加载。
      }
      const differences: string[] = [];
      if (!parsed) {
        differences.push(`无法解析 plist${plistError ? `：${plistError}` : "。"}`);
      } else if (!project) {
        differences.push("任务未关联到当前登记项目。");
      } else if (!project.config) {
        differences.push("无法读取项目计划配置。");
      } else if (!project.config[job].enabled) {
        differences.push("项目配置已停用此任务，但 LaunchAgent 仍存在。");
      } else {
        const expected = parseLaunchAgentPlist(
          buildLaunchAgentPlist({
            projectId: project.projectId,
            projectPath: project.projectPath,
            executablePath: parsed.programArguments[0] ?? options.executablePath,
            job,
            schedule: project.config[job],
          }),
        );
        if (parsed.label !== expected.label)
          differences.push(`Label：期望 ${expected.label}，实际 ${parsed.label ?? "<缺失>"}`);
        if (JSON.stringify(parsed.programArguments) !== JSON.stringify(expected.programArguments)) {
          differences.push(
            `ProgramArguments：期望 ${expected.programArguments.join(" ")}，实际 ${parsed.programArguments.join(" ") || "<缺失>"}`,
          );
        }
        if (JSON.stringify(parsed.intervals) !== JSON.stringify(expected.intervals)) {
          differences.push(
            `StartCalendarInterval：期望 ${JSON.stringify(expected.intervals)}，实际 ${JSON.stringify(parsed.intervals)}`,
          );
        }
        if (parsed.runAtLoad !== false) differences.push(`RunAtLoad：期望 false，实际 ${String(parsed.runAtLoad)}`);
      }
      const actualSchedule = parsed ? launchIntervalsSchedule(job, parsed.intervals) : null;
      const lastResultMatch = /last exit code\s*=\s*(-?\d+)/i.exec(launchOutput);
      const launchState = launchOutput.toLowerCase();
      const systemState: SystemTaskRow["systemState"] =
        !loaded || /\bdisabled\s*=\s*(?:true|1)\b/i.test(launchState)
          ? "Disabled"
          : /\bstate\s*=\s*running\b/i.test(launchState)
            ? "Running"
            : "Ready";
      return {
        taskName: label,
        projectId: project?.projectId ?? null,
        orphaned: project === null,
        job,
        systemState,
        // launchctl print 不包含上次启动时间。
        lastRunAt: null,
        lastResult: lastResultMatch?.[1] ?? null,
        nextRunAt: actualSchedule ? nextRunFor(job, actualSchedule, new Date()) : null,
        triggerSummary: parsed ? launchTriggerSummary(job, parsed.intervals) : "无法读取触发器",
        commandPath: parsed?.programArguments[0] ?? null,
        configMatches: project?.config ? differences.length === 0 : null,
        differences,
      };
    }).then((rows) =>
      rows
        .filter((row): row is SystemTaskRow => row !== null)
        .sort((left, right) => {
          const leftName = left.taskName.toLowerCase();
          const rightName = right.taskName.toLowerCase();
          return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
        }),
    );
  }

  async function reconcile(
    projects: ScheduleProjectDefinition[],
    allowElevation: boolean,
    removedProjectIds: string[] = [],
    onTiming?: AddExistingTimingCallback,
  ): Promise<ScheduleRuntimeStatus> {
    if (platform === "win32") {
      const state = await loadRuntimeState();
      const projectPaths = { ...state.project_paths };
      const removedIds = new Set(removedProjectIds.map((id) => id.toLowerCase()));
      const protectedIds = new Set<string>();
      const currentProjectIds = new Set(projects.map(({ projectId }) => projectId.toLowerCase()));
      const unknownProjectIds = [
        ...new Set(
          state.registered_task_names
            .map(projectIdFromTaskName)
            .filter((projectId): projectId is string => Boolean(projectId)),
        ),
      ].filter((projectId) => !Object.keys(projectPaths).some((id) => id.toLowerCase() === projectId.toLowerCase()));
      await mapWithConcurrency(unknownProjectIds, 4, async (projectId) => {
        const taskName = state.registered_task_names.find(
          (name) => projectIdFromTaskName(name)?.toLowerCase() === projectId.toLowerCase(),
        );
        if (!taskName) return;
        try {
          const xml = await runCommand("schtasks.exe", ["/Query", "/TN", taskName, "/XML"]);
          const projectPath = projectPathFromWindowsTaskXml(xml);
          if (projectPath) projectPaths[projectId] = projectPath;
        } catch {
          // 已不存在或当前用户不可读时，后续注册器仍负责校正任务状态。
        }
      });
      const storageAssessments = await mapWithConcurrency(
        [
          ...projects.map((project) => ({ projectId: project.projectId, projectPath: project.projectPath })),
          ...Object.entries(projectPaths)
            .filter(([projectId]) => !currentProjectIds.has(projectId.toLowerCase()))
            .map(([projectId, projectPath]) => ({ projectId, projectPath })),
        ],
        4,
        async ({ projectId, projectPath }) => ({
          projectId,
          assessment: await inspectStorageLocation(projectPath),
        }),
      );
      for (const { projectId, assessment } of storageAssessments) {
        if (assessment.status === "known-cloud" && !removedIds.has(projectId.toLowerCase())) {
          protectedIds.add(projectId.toLowerCase());
          console.warn("跳过位于已知云同步目录的系统计划任务。");
        }
      }
      for (const removedId of removedIds) protectedIds.delete(removedId);
      const protectedTaskNames = state.registered_task_names.filter((name) => {
        const projectId = projectIdFromTaskName(name);
        return projectId !== null && protectedIds.has(projectId.toLowerCase()) && !removedIds.has(projectId.toLowerCase());
      });
      const previousTaskNames = state.registered_task_names.filter((name) => !protectedTaskNames.includes(name));
      const desired: WindowsTaskDefinition[] = [];
      const obsoleteNames: string[] = [];
      for (const id of removedProjectIds) {
        assertSafeProjectId(id);
        for (const job of WINDOWS_SCHEDULED_JOBS) {
          obsoleteNames.push(windowsTaskName(id, job), windowsRootTaskName(id, job));
        }
      }
      const existingProjectIds = new Set<string>();
      const projectAvailability = await Promise.all(
        projects.map(async (project) => ({ project, exists: await isDirectory(project.projectPath) })),
      );
      for (const { project, exists } of projectAvailability) {
        if (exists) {
          existingProjectIds.add(project.projectId);
        } else {
          console.warn("跳过不存在的项目计划任务。", { projectId: project.projectId });
        }
      }
      for (const project of projects) {
        if (protectedIds.has(project.projectId.toLowerCase())) continue;
        if (!existingProjectIds.has(project.projectId)) continue;
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
        // Registered tasks for known cloud paths are deliberately excluded from
        // the registrar. They remain untouched until a user moves and re-adds
        // the project locally, or explicitly removes the registration.
        previousTaskNames,
        allowElevation,
        state.mode,
        onTiming,
      );
      for (const [id, projectPath] of Object.entries(projectPaths)) {
        if (protectedIds.has(id.toLowerCase())) continue;
        if (existingProjectIds.has(id)) continue;
        try {
          await access(projectPath);
          delete projectPaths[id];
        } catch (error) {
          if (!isMissingPath(error)) throw error;
          // 留存缺失路径，稍后结合注册结果登记仍然存在的任务为孤立任务。
        }
      }
      for (const project of projects) {
        if (existingProjectIds.has(project.projectId) || protectedIds.has(project.projectId.toLowerCase())) {
          projectPaths[project.projectId] = project.projectPath;
        }
      }
      const registeredNames = new Set([...result.registered_task_names, ...protectedTaskNames]);
      const orphanedTasks = state.orphaned_tasks.filter((task) => registeredNames.has(task.taskName));
      for (const [id, projectPath] of Object.entries(projectPaths)) {
        if (protectedIds.has(id.toLowerCase())) continue;
        if (existingProjectIds.has(id)) continue;
        let missing = false;
        try {
          await access(projectPath);
        } catch (error) {
          if (!isMissingPath(error)) throw error;
          missing = true;
        }
        if (!missing) continue;
        const projectTaskNames = WINDOWS_SCHEDULED_JOBS.map((job) => windowsTaskName(id, job));
        if (!projectTaskNames.some((taskName) => registeredNames.has(taskName))) {
          delete projectPaths[id];
          continue;
        }
        for (const job of WINDOWS_SCHEDULED_JOBS) {
          const taskName = windowsTaskName(id, job);
          if (!registeredNames.has(taskName)) continue;
          if (orphanedTasks.some((task) => task.taskName === taskName)) continue;
          orphanedTasks.push({ taskName, path: projectPath, reason: "项目路径不存在，且系统拒绝注销旧计划任务。" });
        }
      }
      const nextState: PersistedWindowsScheduleState = {
        mode:
          protectedIds.size > 0 && desired.length === 0 && obsoleteNames.length === 0 && previousTaskNames.length === 0
            ? state.mode
            : result.mode,
        authorization_required: result.authorization_required,
        registered_task_names: [...registeredNames].sort((left, right) => left.localeCompare(right)),
        project_paths: projectPaths,
        orphaned_tasks: orphanedTasks,
      };
      await saveRuntimeState(nextState);
      return { mode: nextState.mode, authorization_required: nextState.authorization_required };
    }

    if (platform === "darwin") {
      const state = await loadRuntimeState();
      macProjectPaths = new Map(Object.entries(state.mac_project_paths ?? {}));
      const removedIds = new Set(removedProjectIds);
      const currentProjects = projects.filter(({ projectId }) => !removedIds.has(projectId));
      const currentProjectIds = new Set(currentProjects.map(({ projectId }) => projectId));
      const protectedIds = new Set<string>();
      const protectedPaths = new Map<string, string>();
      for (const { projectId, projectPath } of currentProjects) {
        const assessment = await inspectStorageLocation(projectPath);
        if (assessment.status === "known-cloud") {
          protectedIds.add(projectId);
          protectedPaths.set(projectId, projectPath);
        }
      }
      // A cloud project can temporarily disappear from the catalog while its
      // sync volume is unavailable. Reclassify the last known path before
      // treating its LaunchAgents as stale.
      for (const [projectId, projectPath] of macProjectPaths) {
        if (currentProjectIds.has(projectId) || removedIds.has(projectId)) continue;
        const assessment = await inspectStorageLocation(projectPath);
        if (assessment.status === "known-cloud") {
          protectedIds.add(projectId);
          protectedPaths.set(projectId, projectPath);
        }
      }
      const availableProjects: ScheduleProjectDefinition[] = [];
      for (const project of currentProjects) {
        if (protectedIds.has(project.projectId)) {
          console.warn("跳过位于已知云同步目录的系统计划任务。");
          continue;
        }
        if (await isDirectory(project.projectPath)) {
          availableProjects.push(project);
        } else {
          console.warn("跳过不存在的项目计划任务。", { projectId: project.projectId });
        }
      }
      const nextProjectPaths = new Map<string, string>(protectedPaths);
      for (const { projectId, projectPath } of availableProjects) nextProjectPaths.set(projectId, projectPath);
      for (const staleId of new Set([...macProjectPaths.keys(), ...removedProjectIds])) {
        if (nextProjectPaths.has(staleId)) continue;
        for (const job of SCHEDULED_JOBS) await removeMac(staleId, job);
      }
      for (const project of availableProjects) await registerMac(project);
      macProjectPaths = nextProjectPaths;
      await saveRuntimeState({ ...state, mac_project_paths: Object.fromEntries(macProjectPaths) });
    }
    return { mode: "system", authorization_required: false };
  }

  return {
    async listOrphans(projects) {
      if (platform !== "win32") return [];
      const activePaths = new Set(projects.map(({ projectPath }) => pathKey(projectPath)));
      const output = await runCommand("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"]);
      const taskNames = parseWindowsTaskNamesCsv(output);
      const orphans: { taskName: string; path: string; reason: string }[] = [];
      for (const taskName of taskNames) {
        let xml: string;
        try {
          xml = await runCommand("schtasks.exe", ["/Query", "/TN", taskName, "/XML"]);
        } catch {
          continue;
        }
        const projectPath = projectPathFromWindowsTaskXml(xml);
        if (!projectPath) continue;
        const registered = activePaths.has(pathKey(projectPath));
        let directoryExists = true;
        try {
          directoryExists = (await stat(projectPath)).isDirectory();
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          directoryExists = false;
        }
        if (registered && directoryExists) continue;
        orphans.push({
          taskName,
          path: projectPath,
          reason: !directoryExists ? "任务指向的项目路径已不存在。" : "任务所属项目已从本机取消登记。",
        });
      }
      return orphans;
    },
    async removeOrphan(taskName) {
      if (platform !== "win32") throw new Error("当前平台不支持 Windows 计划任务清理。");
      if (!isSiteIndexTaskName(taskName)) throw new Error("只能清理名称以 SiteIndex 开头的计划任务。");
      const state = await loadRuntimeState();
      const identity = taskIdentity(taskName);
      const result = await windowsTaskRegistrar.reconcile([], [taskName], [], true, state.mode);
      if (result.authorization_required) throw new Error("删除计划任务需要管理员授权，任务尚未清理。");
      const registeredNames = state.registered_task_names.filter((name) => {
        if (name.toLowerCase() === taskName.toLowerCase()) return false;
        return !identity || taskIdentity(name) !== identity;
      });
      await saveRuntimeState({
        ...state,
        mode: result.mode,
        authorization_required: result.authorization_required,
        registered_task_names: registeredNames,
      });
    },
    async listSystemTasks(projects) {
      if (platform === "win32") return listWindowsSystemTasks(projects);
      if (platform === "darwin") return listMacSystemTasks(projects);
      return [];
    },
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
    verify,
    reconcile,
    reauthorize(projects) {
      return reconcile(projects, true);
    },
  };
}
