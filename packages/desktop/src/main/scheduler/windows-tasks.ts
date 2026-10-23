import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JobSchedule, ScheduleConfig, Weekday } from "@siteindex/shared";

export const WINDOWS_SCHEDULED_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type WindowsScheduledJob = (typeof WINDOWS_SCHEDULED_JOBS)[number];

export interface WindowsTaskDefinition {
  projectId: string;
  projectPath: string;
  executablePath: string;
  userId: string;
  job: WindowsScheduledJob;
  schedule: JobSchedule;
  options: ScheduleConfig["options"];
  startDate?: string;
}

export interface WindowsTaskOperation {
  action: "create" | "delete";
  name: string;
  xml?: string;
}

export interface WindowsScheduleResult {
  mode: "system" | "resident";
  authorization_required: boolean;
  registered_task_names: string[];
}

export interface WindowsTaskRegistrar {
  reconcile(
    desired: WindowsTaskDefinition[],
    obsoleteNames: string[],
    previousNames: string[],
    allowElevation: boolean,
    previousMode?: WindowsScheduleResult["mode"],
  ): Promise<WindowsScheduleResult>;
}

type CommandRunner = (file: string, args: string[]) => Promise<string>;
type ElevatedScriptRunner = (scriptPath: string, resultPath: string) => Promise<void>;

interface WindowsTaskRegistrarOptions {
  userId?: string;
  runCommand?: CommandRunner;
  runElevatedScript?: ElevatedScriptRunner;
  beforeElevation?: () => Promise<void>;
  temporaryDirectory?: string;
}

interface CommandError extends Error {
  code?: number | string;
  detail?: string;
  stdout?: string;
  stderr?: string;
}

const execFileAsync = promisify(execFile);
const WINDOWS_DAYS: Record<Weekday, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};
const WINDOWS_MONTHS = [
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

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileAsync(file, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" })
      .then(({ stdout }) => resolve(stdout))
      .catch((error: unknown) => {
        const commandError = error as CommandError & { stderr?: string };
        const detail = [commandError.stdout, commandError.stderr].filter(Boolean).join("\n");
        reject(Object.assign(new Error(`${file} 执行失败。`), { code: commandError.code, detail, cause: error }));
      });
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertSafeProjectId(projectId: string): void {
  if (!projectId || /[\\/\0\r\n]/.test(projectId)) throw new Error("项目标识不能包含路径分隔符。");
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`无效的计划时间：${time}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function selectedWeekdays(schedule: JobSchedule): Weekday[] {
  const days = [...new Set(schedule.days ?? [])].sort((left, right) => left - right);
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("启用的每周计划必须选择有效的星期。");
  }
  return days;
}

function datePart(value: string | undefined): string {
  if (!value) {
    const now = new Date();
    return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00`).getTime())) {
    throw new Error(`无效的计划开始日期：${value}`);
  }
  return value;
}

export function windowsTaskName(projectId: string, job: WindowsScheduledJob): string {
  assertSafeProjectId(projectId);
  return `\\SiteIndex\\${projectId}-${job}`;
}

export function windowsRootTaskName(projectId: string, job: WindowsScheduledJob): string {
  assertSafeProjectId(projectId);
  return `SiteIndex - ${projectId}-${job}`;
}

function triggerXml(definition: WindowsTaskDefinition): string {
  const { hour, minute } = parseTime(definition.schedule.time);
  const startBoundary = `${datePart(definition.startDate)}T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00`;
  if (definition.job === "monthly") {
    const day = definition.schedule.day_of_month;
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) {
      throw new Error("每月计划必须选择 1 至 31 日。");
    }
    return `<CalendarTrigger><StartBoundary>${startBoundary}</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>${day}</Day></DaysOfMonth><Months>${WINDOWS_MONTHS.map((month) => `<${month}/>`).join("")}</Months></ScheduleByMonth></CalendarTrigger>`;
  }
  const weekdays = selectedWeekdays(definition.schedule);
  return `<CalendarTrigger><StartBoundary>${startBoundary}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek>${weekdays.map((day) => `<${WINDOWS_DAYS[day]}/>`).join("")}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
}

export function buildWindowsTaskXml(definition: WindowsTaskDefinition): string {
  const args = `--run-job "${definition.projectPath}" ${definition.job}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>SiteIndex</Author><Description>SiteIndex ${escapeXml(definition.projectId)} ${definition.job}</Description></RegistrationInfo>
  <Triggers>${triggerXml(definition)}</Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(definition.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>${definition.options.run_if_missed ? "true" : "false"}</StartWhenAvailable><WakeToRun>${definition.options.wake_to_run ? "true" : "false"}</WakeToRun><Enabled>true</Enabled><ExecutionTimeLimit>PT2H</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(definition.executablePath)}</Command><Arguments>${escapeXml(args)}</Arguments><WorkingDirectory>${escapeXml(definition.projectPath)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

export function windowsTaskXmlBytes(xml: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

function isAccessDenied(error: unknown): boolean {
  const value = error as CommandError;
  const detail = `${value?.message ?? ""}\n${value?.detail ?? ""}`;
  const containsUndecodableOutput = detail.includes("\uFFFD");
  return (
    /0x80070005|0x5\b|access is denied|拒绝访问/i.test(detail) ||
    (value?.code === 1 && (!value.detail?.trim() || containsUndecodableOutput))
  );
}

function isMissingTask(error: unknown): boolean {
  const value = error as CommandError;
  const detail = `${value?.message ?? ""}\n${value?.detail ?? ""}`;
  return /0x80070002|cannot find the file specified|cannot find the path specified|does not exist|not found|找不到|不存在/i.test(
    detail,
  );
}

function normalizedXml(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizedSchedule(value: string): string | null {
  const match = /<scheduleby(?:month|week)>[\s\S]*?<\/scheduleby(?:month|week)>/.exec(normalizedXml(value));
  return match?.[0].replace(/<startboundary>[\s\S]*?<\/startboundary>/, "") ?? null;
}

function taskMatches(actualXml: string, definition: WindowsTaskDefinition): boolean {
  const actual = normalizedXml(actualXml);
  const expected = normalizedXml(buildWindowsTaskXml(definition));
  const required = [
    `<userid>${escapeXml(definition.userId).toLowerCase()}</userid>`,
    "<logontype>interactivetoken</logontype>",
    "<runlevel>leastprivilege</runlevel>",
    `<command>${escapeXml(definition.executablePath).toLowerCase()}</command>`,
    `<arguments>${escapeXml(`--run-job "${definition.projectPath}" ${definition.job}`).toLowerCase()}</arguments>`,
    `<workingdirectory>${escapeXml(definition.projectPath).toLowerCase()}</workingdirectory>`,
    `<startwhenavailable>${definition.options.run_if_missed ? "true" : "false"}</startwhenavailable>`,
    `<waketorun>${definition.options.wake_to_run ? "true" : "false"}</waketorun>`,
    "<multipleinstancespolicy>ignorenew</multipleinstancespolicy>",
    "<executiontimelimit>pt2h</executiontimelimit>",
    definition.job === "monthly" ? "<schedulebymonth>" : "<schedulebyweek>",
  ];
  const expectedSchedule = normalizedSchedule(expected);
  return (
    required.every((fragment) => actual.includes(fragment)) &&
    Boolean(expectedSchedule && normalizedSchedule(actualXml)?.includes(expectedSchedule))
  );
}

function buildElevatedScript(operations: WindowsTaskOperation[], resultPath: string): string {
  const serializedOperations = operations.map((operation) => ({
    action: operation.action,
    name: operation.name,
    xmlBase64: operation.xml ? Buffer.from(windowsTaskXmlBytes(operation.xml)).toString("base64") : null,
  }));
  const operationsBase64 = Buffer.from(JSON.stringify(serializedOperations), "utf8").toString("base64");
  return `param([string]$ResultPath)
$ErrorActionPreference = 'Stop'
$operationsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${operationsBase64}'))
$operations = ConvertFrom-Json -InputObject $operationsJson
$results = @()
for ($index = 0; $index -lt $operations.Count; $index++) {
  $operation = $operations[$index]
  $output = ''
  $code = 0
  $xmlPath = $null
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if ($operation.action -eq 'create') {
      $xmlPath = Join-Path $env:TEMP ('siteindex-task-' + [Guid]::NewGuid().ToString('N') + '.xml')
      [IO.File]::WriteAllBytes($xmlPath, [Convert]::FromBase64String($operation.xmlBase64))
      $output = (& schtasks.exe /Create /TN "$($operation.name)" /XML "$xmlPath" /F 2>&1 | Out-String)
    } else {
      $output = (& schtasks.exe /Delete /TN "$($operation.name)" /F 2>&1 | Out-String)
    }
    $code = $LASTEXITCODE
    $missing = $output -match '0x80070002|cannot find the file specified|cannot find the path specified|does not exist|not found|找不到|不存在'
    $denied = $output -match '0x80070005|access is denied|拒绝访问'
    $success = ($code -eq 0) -or ($operation.action -eq 'delete' -and $missing -and -not $denied)
  } catch {
    $output = $_.Exception.Message
    $success = $false
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($xmlPath) { Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue }
  }
  $results += [pscustomobject]@{ name = $operation.name; action = $operation.action; success = [bool]$success; exit_code = $code; detail = $output.Trim() }
}
$result = @{ success = [bool](($results | Where-Object { -not $_.success }).Count -eq 0); results = $results }
[IO.File]::WriteAllText(${escapePowerShell(resultPath)}, (ConvertTo-Json -InputObject $result -Depth 8), [Text.UTF8Encoding]::new($false))
if (-not $result.success) { exit 1 }
`;
}

async function runElevatedScript(scriptPath: string, resultPath: string): Promise<void> {
  const argumentsText = `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ResultPath "${resultPath}"`;
  const command = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList ${escapePowerShell(argumentsText)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
  await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]).catch(() => undefined);
}

async function applyNormalOperations(
  operations: WindowsTaskOperation[],
  temporaryDirectory: string,
  runner: CommandRunner,
): Promise<void> {
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    if (operation.action === "delete") {
      await runner("schtasks.exe", ["/Delete", "/TN", operation.name, "/F"]).catch((error: unknown) => {
        if (!isMissingTask(error)) throw error;
      });
      continue;
    }
    if (!operation.xml) throw new Error(`任务 ${operation.name} 缺少 XML。`);
    const xmlPath = path.join(temporaryDirectory, `task-${index}.xml`);
    await writeFile(xmlPath, windowsTaskXmlBytes(operation.xml));
    await runner("schtasks.exe", ["/Create", "/TN", operation.name, "/XML", xmlPath, "/F"]);
  }
}

async function taskExists(name: string, runner: CommandRunner): Promise<boolean> {
  try {
    await runner("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
    return true;
  } catch (error) {
    if (isMissingTask(error)) return false;
    throw error;
  }
}

export function createWindowsTaskRegistrar(options: WindowsTaskRegistrarOptions = {}): WindowsTaskRegistrar {
  const runner = options.runCommand ?? runCommand;
  const runElevated = options.runElevatedScript ?? runElevatedScript;
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();

  async function applyElevated(operations: WindowsTaskOperation[]): Promise<boolean> {
    const directory = await mkdtemp(path.join(temporaryDirectory, "siteindex-schedule-admin-"));
    const scriptPath = path.join(directory, "register-tasks.ps1");
    const resultPath = path.join(directory, "result.json");
    try {
      await writeFile(scriptPath, `\uFEFF${buildElevatedScript(operations, resultPath)}`, { encoding: "utf8" });
      await runElevated(scriptPath, resultPath);
      const value: unknown = JSON.parse(await readFile(resultPath, "utf8"));
      if (typeof value !== "object" || value === null || !("success" in value) || value.success !== true) return false;
      if (!("results" in value)) return false;
      const results = value.results;
      if (!Array.isArray(results) || results.length !== operations.length) return false;
      return operations.every((operation, index) => {
        const result: unknown = results[index];
        return (
          typeof result === "object" &&
          result !== null &&
          "success" in result &&
          result.success === true &&
          "action" in result &&
          result.action === operation.action &&
          "name" in result &&
          result.name === operation.name
        );
      });
    } catch {
      return false;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return {
    async reconcile(desired, obsoleteNames, previousNames, allowElevation, previousMode) {
      const definitions = new Map(
        desired.map((definition) => [windowsTaskName(definition.projectId, definition.job), definition]),
      );
      const desiredNames = [...definitions.keys()].sort();
      const deleteNames = [...new Set([...previousNames, ...obsoleteNames])]
        .filter((name) => !definitions.has(name))
        .sort();
      const operations: WindowsTaskOperation[] = [];

      for (const name of deleteNames) {
        try {
          if (await taskExists(name, runner)) operations.push({ action: "delete", name });
        } catch (error) {
          if (!isAccessDenied(error)) throw error;
          operations.push({ action: "delete", name });
        }
      }

      const userId = options.userId ?? (await runner("whoami.exe", [])).trim();
      if (!/^[^\\/\r\n]+\\[^\\/\r\n]+$/.test(userId)) throw new Error("whoami 未返回计算机名\\用户名格式的当前用户。");
      const createOperations: WindowsTaskOperation[] = [];
      for (const [name, definition] of definitions) {
        try {
          const existingXml = await runner("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
          if (!taskMatches(existingXml, { ...definition, userId })) {
            createOperations.push({ action: "create", name, xml: buildWindowsTaskXml({ ...definition, userId }) });
          }
        } catch (error) {
          if (isMissingTask(error)) {
            createOperations.push({ action: "create", name, xml: buildWindowsTaskXml({ ...definition, userId }) });
          } else if (isAccessDenied(error)) {
            createOperations.push({ action: "create", name, xml: buildWindowsTaskXml({ ...definition, userId }) });
          } else throw error;
        }
      }

      const normalOperations: WindowsTaskOperation[] = [
        ...createOperations,
        ...operations.filter((operation) => operation.action === "delete"),
      ];
      const elevatedOperations: WindowsTaskOperation[] = [
        ...[...definitions].map(([name, definition]) => ({
          action: "create" as const,
          name,
          xml: buildWindowsTaskXml({ ...definition, userId }),
        })),
        ...deleteNames.map((name) => ({ action: "delete" as const, name })),
      ];

      if (normalOperations.length > 0) {
        const directory = await mkdtemp(path.join(temporaryDirectory, "siteindex-schedule-"));
        try {
          await applyNormalOperations(normalOperations, directory, runner);
        } catch (error) {
          if (!isAccessDenied(error)) throw error;
          if (!allowElevation) {
            return {
              mode: previousMode ?? "system",
              authorization_required: true,
              registered_task_names: previousNames,
            };
          }
          try {
            await options.beforeElevation?.();
          } catch {
            return { mode: "resident", authorization_required: true, registered_task_names: previousNames };
          }
          const success = await applyElevated(elevatedOperations);
          if (!success) return { mode: "resident", authorization_required: true, registered_task_names: previousNames };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }

      return { mode: "system", authorization_required: false, registered_task_names: desiredNames };
    },
  };
}
