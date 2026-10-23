import type { JobSchedule, ScheduleConfig, ScheduleState, Weekday } from "@siteindex/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const SCHEDULED_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export interface WindowsTaskDefinition {
  projectId: string;
  projectPath: string;
  executablePath: string;
  userId: string;
  job: ScheduledJob;
  schedule: JobSchedule;
  options: ScheduleConfig["options"];
  now?: Date;
}

export interface LaunchAgentDefinition {
  projectId: string;
  projectPath: string;
  executablePath: string;
  job: ScheduledJob;
  schedule: JobSchedule;
}

export interface SystemScheduler {
  getState(projectId: string, projectPath: string, config: ScheduleConfig): Promise<ScheduleState>;
  sync(projectId: string, projectPath: string, config: ScheduleConfig): Promise<ScheduleState>;
  removeProject(projectId: string): Promise<void>;
}

const WINDOWS_WEEKDAYS: Record<Weekday, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

const LAUNCHD_WEEKDAYS: Record<Weekday, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 0,
};

const ALL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
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

export function windowsTaskName(projectId: string, job: ScheduledJob): string {
  assertSafeProjectId(projectId);
  return `\\SiteIndex\\${projectId}-${job}`;
}

export function windowsRootTaskName(projectId: string, job: ScheduledJob): string {
  assertSafeProjectId(projectId);
  return `SiteIndex - ${projectId}-${job}`;
}

export function windowsTaskNames(projectId: string, job: ScheduledJob): string[] {
  return [windowsTaskName(projectId, job), windowsRootTaskName(projectId, job)];
}

export function launchAgentLabel(projectId: string, job: ScheduledJob): string {
  assertSafeProjectId(projectId);
  const safeId = projectId.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const suffix = createHash("sha256").update(projectId).digest("hex").slice(0, 8);
  return `com.siteindex.${safeId}.${suffix}.${job}`;
}

export function buildWindowsTaskXml(definition: WindowsTaskDefinition): string {
  assertSafeProjectId(definition.projectId);
  if (!definition.userId.trim()) throw new Error("Windows 计划任务缺少当前用户标识。");
  const { hour, minute } = parseTime(definition.schedule.time);
  const startBoundary = `${localDate(definition.now ?? new Date())}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:00`;
  const calendar =
    definition.job === "monthly"
      ? (() => {
          const day = definition.schedule.day_of_month;
          if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) {
            throw new Error("每月计划必须选择 1 至 31 日。");
          }
          return `<ScheduleByMonth><DaysOfMonth><Day>${day}</Day></DaysOfMonth><Months>${ALL_MONTHS.map((month) => `<${month}/>`).join("")}</Months></ScheduleByMonth>`;
        })()
      : `<ScheduleByWeek><DaysOfWeek>${selectedWeekdays(definition.schedule)
          .map((day) => `<${WINDOWS_WEEKDAYS[day]}/>`)
          .join("")}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>`;
  const runMissed = definition.options.run_if_missed ? "true" : "false";
  const wake = definition.options.wake_to_run ? "true" : "false";
  const argumentsText = `--run-job \"${definition.projectPath}\" ${definition.job}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>SiteIndex</Author></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>${startBoundary}</StartBoundary><Enabled>true</Enabled>${calendar}</CalendarTrigger></Triggers>
  <Principals><Principal id="SiteIndex"><UserId>${escapeXml(definition.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>${runMissed}</StartWhenAvailable><WakeToRun>${wake}</WakeToRun><Enabled>true</Enabled><AllowStartOnDemand>true</AllowStartOnDemand><ExecutionTimeLimit>PT2H</ExecutionTimeLimit></Settings>
  <Actions Context="SiteIndex"><Exec><Command>${escapeXml(definition.executablePath)}</Command><Arguments>${escapeXml(argumentsText)}</Arguments><WorkingDirectory>${escapeXml(definition.projectPath)}</WorkingDirectory></Exec></Actions>
</Task>
`;
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
  if (job === "monthly" && (!Number.isInteger(schedule.day_of_month) || schedule.day_of_month! < 1 || schedule.day_of_month! > 31)) {
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

async function windowsUserId(runCommand: (file: string, args: string[]) => Promise<string>): Promise<string> {
  const identity = (await runCommand("whoami.exe", [])).trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!identity || !identity.includes("\\")) {
    throw new Error("whoami 未返回 Windows 计划任务所需的完整用户标识。");
  }
  return identity;
}

function isAccessDenied(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown; detail?: unknown; cause?: unknown };
  const numericCode = typeof record.code === "number" ? record.code >>> 0 : Number.NaN;
  if (
    record.code === "EACCES" || record.code === "EPERM" || record.code === "E_ACCESSDENIED" ||
    numericCode === 0x80070005
  ) return true;
  const text = [record.message, record.detail, record.cause instanceof Error ? record.cause.message : ""]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return /access is denied|access denied|拒绝访问|0x80070005|E_ACCESSDENIED/i.test(text);
}

export function createSystemScheduler(options: {
  platform?: NodeJS.Platform;
  executablePath: string;
  homeDirectory?: string;
  userId?: string;
  uid?: number;
  runCommand?: (file: string, args: string[]) => Promise<string>;
}): SystemScheduler {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? execute;
  const homeDirectory = options.homeDirectory ?? homedir();
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const agentDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
  let ensureTaskFolderPromise: Promise<void> | null = null;

  function taskPath(projectId: string, job: ScheduledJob): string {
    return windowsTaskName(projectId, job);
  }

  function plistPath(projectId: string, job: ScheduledJob): string {
    return path.join(agentDirectory, `${launchAgentLabel(projectId, job)}.plist`);
  }

  async function ensureWindowsTaskFolder(): Promise<void> {
    if (!ensureTaskFolderPromise) {
      const script = "$service = New-Object -ComObject Schedule.Service; $service.Connect(); $root = $service.GetFolder('\\'); try { $null = $service.GetFolder('\\SiteIndex') } catch { $null = $root.CreateFolder('SiteIndex', $null) }";
      ensureTaskFolderPromise = runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])
        .then(() => undefined)
        .catch((error) => {
          ensureTaskFolderPromise = null;
          throw error;
        });
    }
    await ensureTaskFolderPromise;
  }

  async function registerWindows(projectId: string, projectPath: string, config: ScheduleConfig): Promise<void> {
    let nestedFolderAvailable = true;
    try {
      await ensureWindowsTaskFolder();
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
      console.warn("无法访问 SiteIndex 计划任务文件夹，将尝试注册到任务根目录。", error);
      nestedFolderAvailable = false;
    }
    const userId = options.userId ?? await windowsUserId(runCommand);
    for (const job of SCHEDULED_JOBS) {
      const schedule = jobDefinition(config, job);
      if (!schedule.enabled) {
        await removeWindows(projectId, job);
        continue;
      }
      await removeWindows(projectId, job);
      const directory = await mkdtemp(path.join(tmpdir(), "siteindex-task-"));
      const xmlPath = path.join(directory, "task.xml");
      const xml = buildWindowsTaskXml({
        projectId,
        projectPath,
        executablePath: options.executablePath,
        userId,
        job,
        schedule,
        options: config.options,
      });
      try {
        const body = Buffer.from(xml, "utf16le");
        await writeFile(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
        const nestedName = taskPath(projectId, job);
        const rootName = windowsRootTaskName(projectId, job);
        if (nestedFolderAvailable) {
          try {
            await runCommand("schtasks.exe", ["/Create", "/TN", nestedName, "/XML", xmlPath, "/F", "/HRESULT"]);
            continue;
          } catch (error) {
            if (!isAccessDenied(error)) throw error;
            nestedFolderAvailable = false;
          }
        }
        await runCommand("schtasks.exe", ["/Create", "/TN", rootName, "/XML", xmlPath, "/F", "/HRESULT"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  async function removeWindows(projectId: string, job: ScheduledJob): Promise<void> {
    for (const name of windowsTaskNames(projectId, job)) {
      try {
        await runCommand("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
      } catch {
        continue;
      }
      await runCommand("schtasks.exe", ["/Delete", "/TN", name, "/F"]);
    }
  }

  async function isWindowsRegistered(projectId: string, job: ScheduledJob): Promise<boolean> {
    for (const name of windowsTaskNames(projectId, job)) {
      try {
        await runCommand("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
        return true;
      } catch {
        // 检查根目录兼容任务。
      }
    }
    return false;
  }

  async function registerMac(projectId: string, projectPath: string, config: ScheduleConfig): Promise<void> {
    await mkdir(agentDirectory, { recursive: true });
    for (const job of SCHEDULED_JOBS) {
      const schedule = jobDefinition(config, job);
      if (!schedule.enabled) {
        await removeMac(projectId, job);
        continue;
      }
      const label = launchAgentLabel(projectId, job);
      const filePath = plistPath(projectId, job);
      const content = buildLaunchAgentPlist({ projectId, projectPath, executablePath: options.executablePath, job, schedule });
      await runCommand("launchctl", ["bootout", `gui/${uid}`, filePath]).catch(() => undefined);
      await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
      await runCommand("launchctl", ["bootstrap", `gui/${uid}`, filePath]);
    }
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

  async function isMacRegistered(projectId: string, job: ScheduledJob): Promise<boolean> {
    try {
      await access(plistPath(projectId, job));
      await runCommand("launchctl", ["print", `gui/${uid}/${launchAgentLabel(projectId, job)}`]);
      return true;
    } catch {
      return false;
    }
  }

  async function registered(projectId: string, config: ScheduleConfig): Promise<boolean> {
    if (platform !== "win32" && platform !== "darwin") return false;
    const checks = await Promise.all(
      SCHEDULED_JOBS.filter((job) => config[job].enabled).map((job) =>
        platform === "win32" ? isWindowsRegistered(projectId, job) : isMacRegistered(projectId, job),
      ),
    );
    return checks.every(Boolean);
  }

  return {
    async getState(projectId, projectPath, config) {
      void projectPath;
      return {
        config,
        registered: await registered(projectId, config),
        next_runs: calculateNextRuns(config),
      };
    },
    async sync(projectId, projectPath, config) {
      assertSafeProjectId(projectId);
      if (platform === "win32") await registerWindows(projectId, projectPath, config);
      else if (platform === "darwin") await registerMac(projectId, projectPath, config);
      return {
        config,
        registered: await registered(projectId, config),
        next_runs: calculateNextRuns(config),
      };
    },
    async removeProject(projectId) {
      for (const job of SCHEDULED_JOBS) {
        if (platform === "win32") await removeWindows(projectId, job);
        else if (platform === "darwin") await removeMac(projectId, job);
      }
    },
  };
}
