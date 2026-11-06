import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { promisify } from "node:util";
import { DOMParser } from "@xmldom/xmldom";
import type { JobSchedule, ScheduleConfig, Weekday } from "@siteindex/shared";
import type { AddExistingTimingCallback, AddExistingTracePhase } from "../add-existing-trace.js";
import { mapWithConcurrency } from "./concurrency.js";

type SchedulerDiagnosticPhase = Extract<
  AddExistingTracePhase,
  "scheduler.task_list" | "scheduler.task_query" | "scheduler.task_apply" | "scheduler.elevation_wait"
>;

export const WINDOWS_SCHEDULED_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type WindowsScheduledJob = (typeof WINDOWS_SCHEDULED_JOBS)[number];
type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
type XmlElement = NonNullable<XmlDocument["documentElement"]>;

export interface WindowsTaskDefinition {
  projectId: string;
  projectPath: string;
  executablePath: string;
  userId: string;
  userSid?: string;
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
    onTiming?: AddExistingTimingCallback,
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

async function measureSchedulerPhase<T>(
  onTiming: AddExistingTimingCallback | undefined,
  phase: SchedulerDiagnosticPhase,
  operation: () => Promise<T>,
): Promise<T> {
  if (!onTiming) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    onTiming(phase, performance.now() - startedAt);
  }
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

// Windows 控制台程序（schtasks、whoami、chcp）按 OEM 代码页输出，中文系统为 936（GBK）。
// 直接按 UTF-8 解码会得到乱码，导致“任务不存在”被误判为“拒绝访问”并反复触发提权注册。
const OEM_CODE_PAGE_ENCODINGS: Record<number, string> = {
  65001: "utf-8",
  936: "gbk",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  866: "ibm866",
  1252: "windows-1252",
};

export function decodeConsoleOutput(bytes: Uint8Array, codePage: number | null): string {
  if (bytes.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const encoding = (codePage != null && OEM_CODE_PAGE_ENCODINGS[codePage]) || "gbk";
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

export function parseCodePage(output: string): number | null {
  const match = /(\d{3,5})\s*$/.exec(output.trim());
  return match ? Number(match[1]) : null;
}

let oemCodePage: Promise<number | null> | null = null;
function currentCodePage(): Promise<number | null> {
  oemCodePage ??= new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(null);
      return;
    }
    execFile("cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, encoding: "buffer" }, (error, stdout) => {
      resolve(error ? null : parseCodePage(new TextDecoder("latin1").decode(stdout)));
    });
  });
  return oemCodePage;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array();
}

async function runCommand(file: string, args: string[]): Promise<string> {
  const codePage = await currentCodePage();
  try {
    const { stdout } = await execFileAsync(file, args, {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "buffer",
    });
    return decodeConsoleOutput(toBytes(stdout), codePage);
  } catch (error: unknown) {
    const commandError = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
    const stdout = decodeConsoleOutput(toBytes(commandError.stdout), codePage);
    const stderr = decodeConsoleOutput(toBytes(commandError.stderr), codePage);
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw Object.assign(new Error(`${file} 执行失败。`), {
      code: commandError.code,
      detail,
      stdout,
      stderr,
      cause: error,
    });
  }
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

export function isWindowsTaskMissing(error: unknown): boolean {
  const value = error as CommandError;
  const detail = `${value?.message ?? ""}\n${value?.detail ?? ""}`;
  return /0x80070002|cannot find the file specified|cannot find the path specified|does not exist|not found|找不到|不存在/i.test(
    detail,
  );
}

export interface WindowsTaskDifference {
  field: string;
  expected: string;
  actual: string;
}

interface ParsedTaskTrigger {
  startTime: string | null;
  enabled: string;
  kind: "weekly" | "monthly" | "unknown";
  weekdays: string[];
  weeksInterval: string | null;
  monthDays: string[];
  months: string[];
}

interface ParsedWindowsTask {
  userId: string | null;
  logonType: string | null;
  runLevel: string;
  command: string | null;
  arguments: string | null;
  workingDirectory: string | null;
  startWhenAvailable: string;
  wakeToRun: string;
  multipleInstancesPolicy: string;
  executionTimeLimit: string;
  disallowStartIfOnBatteries: string;
  stopIfGoingOnBatteries: string;
  allowHardTerminate: string;
  enabled: string;
  priority: string;
  triggerCount: number;
  actionCount: number;
  trigger: ParsedTaskTrigger | null;
}

export interface WindowsTaskInspection {
  commandPath: string | null;
  arguments: string | null;
  workingDirectory: string | null;
  enabled: boolean;
  trigger: {
    kind: "weekly" | "monthly" | "unknown";
    enabled: boolean;
    startTime: string | null;
    weekdays: string[];
    monthDays: string[];
  } | null;
}

export interface WindowsTaskRuntimeRow {
  taskName: string;
  nextRunTime: string | null;
  status: string | null;
  lastRunTime: string | null;
  lastResult: string | null;
}

function taskXmlDocument(xml: string): XmlDocument {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") errors.push(message);
    },
  }).parseFromString(xml.replace(/^\uFEFF/, ""), "application/xml");
  if (errors.length || document.documentElement?.localName !== "Task") {
    throw new Error(errors[0] ?? "XML 根元素不是 Task。");
  }
  return document;
}

function elements(parent: XmlDocument | XmlElement, tagName: string): XmlElement[] {
  return Array.from(parent.getElementsByTagName(tagName));
}

function elementText(parent: XmlDocument | XmlElement, tagName: string): string | null {
  return elements(parent, tagName)[0]?.textContent?.trim() || null;
}

function taskSetting(document: XmlDocument | XmlElement, tagName: string, defaultValue: string): string {
  return elementText(document, tagName) ?? defaultValue;
}

function parseWindowsTask(xml: string): ParsedWindowsTask {
  const document = taskXmlDocument(xml);
  const settings = elements(document, "Settings")[0] ?? document;
  const triggerElement = elements(document, "CalendarTrigger")[0];
  let trigger: ParsedTaskTrigger | null = null;
  if (triggerElement) {
    const startBoundary = elementText(triggerElement, "StartBoundary");
    const startTimeMatch = startBoundary ? /T(\d{2}:\d{2})(?::\d{2})?/.exec(startBoundary) : null;
    const weekly = elements(triggerElement, "ScheduleByWeek").length > 0;
    const monthly = elements(triggerElement, "ScheduleByMonth").length > 0;
    trigger = {
      startTime: startTimeMatch?.[1] ?? null,
      enabled: elementText(triggerElement, "Enabled") ?? "true",
      kind: weekly ? "weekly" : monthly ? "monthly" : "unknown",
      weekdays: elements(triggerElement, "DaysOfWeek")
        .flatMap((element) => Array.from(element.children).map((day) => day.localName ?? day.nodeName))
        .sort(),
      weeksInterval: elementText(triggerElement, "WeeksInterval"),
      monthDays: elements(triggerElement, "DaysOfMonth")
        .flatMap((element) => Array.from(element.children).map((day) => day.textContent?.trim() ?? ""))
        .sort(),
      months: elements(triggerElement, "Months")
        .flatMap((element) => Array.from(element.children).map((month) => month.localName ?? month.nodeName))
        .sort(),
    };
  }
  return {
    userId: elementText(document, "UserId"),
    logonType: elementText(document, "LogonType"),
    // Task Scheduler omits schema defaults when exporting a registered task.
    runLevel: elementText(document, "RunLevel") ?? "LeastPrivilege",
    command: elementText(document, "Command"),
    arguments: elementText(document, "Arguments"),
    workingDirectory: elementText(document, "WorkingDirectory"),
    startWhenAvailable: taskSetting(settings, "StartWhenAvailable", "false"),
    wakeToRun: taskSetting(settings, "WakeToRun", "false"),
    multipleInstancesPolicy: taskSetting(settings, "MultipleInstancesPolicy", "IgnoreNew"),
    executionTimeLimit: taskSetting(settings, "ExecutionTimeLimit", "PT72H"),
    disallowStartIfOnBatteries: taskSetting(settings, "DisallowStartIfOnBatteries", "true"),
    stopIfGoingOnBatteries: taskSetting(settings, "StopIfGoingOnBatteries", "true"),
    allowHardTerminate: taskSetting(settings, "AllowHardTerminate", "true"),
    enabled: taskSetting(settings, "Enabled", "true"),
    priority: taskSetting(settings, "Priority", "7"),
    triggerCount: elements(document, "CalendarTrigger").length,
    actionCount: elements(document, "Actions")[0]?.children.length ?? 0,
    trigger,
  };
}

export function inspectWindowsTaskXml(xml: string): WindowsTaskInspection {
  const task = parseWindowsTask(xml);
  return {
    commandPath: task.command,
    arguments: task.arguments,
    workingDirectory: task.workingDirectory,
    enabled: task.enabled.toLowerCase() === "true",
    trigger: task.trigger
      ? {
          kind: task.trigger.kind,
          enabled: task.trigger.enabled.toLowerCase() === "true",
          startTime: task.trigger.startTime,
          weekdays: task.trigger.weekdays,
          monthDays: task.trigger.monthDays,
        }
      : null,
  };
}

function normalizedField(value: string | null): string {
  return (value ?? "<缺失>").trim().replaceAll("/", "\\").toLowerCase();
}

function displayField(value: string | null): string {
  return value ?? "<缺失>";
}

export function windowsTaskUserId(xml: string): string | null {
  return parseWindowsTask(xml).userId;
}

export function parseWindowsUserSid(output: string): string | null {
  return /\bS-1-\d+(?:-\d+)+\b/i.exec(output)?.[0] ?? null;
}

export function isWindowsUserSid(value: string | null): boolean {
  return value != null && /^S-1-\d+(?:-\d+)+$/i.test(value);
}

export function windowsTaskDifferences(actualXml: string, definition: WindowsTaskDefinition): WindowsTaskDifference[] {
  let actual: ParsedWindowsTask;
  try {
    actual = parseWindowsTask(actualXml);
  } catch (error) {
    return [
      {
        field: "XML",
        expected: "有效的 Task Scheduler 任务 XML",
        actual: `无法解析：${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  const expectedXml = parseWindowsTask(buildWindowsTaskXml(definition));
  const expectedArguments = `--run-job "${definition.projectPath}" ${definition.job}`;
  const expectedUserId = definition.userSid ? `${definition.userId} or ${definition.userSid}` : definition.userId;
  const userIdMatches =
    normalizedField(actual.userId) === normalizedField(definition.userId) ||
    (definition.userSid != null && normalizedField(actual.userId) === normalizedField(definition.userSid));
  const comparisons: { field: string; expected: string | null; actual: string | null }[] = [
    { field: "LogonType", expected: "InteractiveToken", actual: actual.logonType },
    { field: "RunLevel", expected: "LeastPrivilege", actual: actual.runLevel },
    { field: "Command", expected: definition.executablePath, actual: actual.command },
    { field: "Arguments", expected: expectedArguments, actual: actual.arguments },
    { field: "WorkingDirectory", expected: definition.projectPath, actual: actual.workingDirectory },
    {
      field: "StartWhenAvailable",
      expected: definition.options.run_if_missed ? "true" : "false",
      actual: actual.startWhenAvailable,
    },
    { field: "WakeToRun", expected: definition.options.wake_to_run ? "true" : "false", actual: actual.wakeToRun },
    { field: "MultipleInstancesPolicy", expected: "IgnoreNew", actual: actual.multipleInstancesPolicy },
    { field: "ExecutionTimeLimit", expected: "PT2H", actual: actual.executionTimeLimit },
    { field: "DisallowStartIfOnBatteries", expected: "false", actual: actual.disallowStartIfOnBatteries },
    { field: "StopIfGoingOnBatteries", expected: "false", actual: actual.stopIfGoingOnBatteries },
    { field: "AllowHardTerminate", expected: "true", actual: actual.allowHardTerminate },
    { field: "Enabled", expected: "true", actual: actual.enabled },
    { field: "Priority", expected: "7", actual: actual.priority },
    { field: "Trigger.Count", expected: "1", actual: String(actual.triggerCount) },
    { field: "Action.Count", expected: "1", actual: String(actual.actionCount) },
  ];
  const differences: WindowsTaskDifference[] = [];
  if (!userIdMatches) {
    differences.push({ field: "UserId", expected: expectedUserId, actual: displayField(actual.userId) });
  }
  for (const comparison of comparisons) {
    const expectedValue = normalizedField(comparison.expected);
    const actualValue = normalizedField(comparison.actual);
    if (expectedValue !== actualValue) {
      differences.push({
        field: comparison.field,
        expected: displayField(comparison.expected),
        actual: displayField(comparison.actual),
      });
    }
  }

  const expectedTrigger = expectedXml.trigger;
  const actualTrigger = actual.trigger;
  const expectedDays =
    definition.job === "monthly"
      ? []
      : selectedWeekdays(definition.schedule)
          .map((day) => WINDOWS_DAYS[day])
          .sort();
  const expectedMonths = definition.job === "monthly" ? [...WINDOWS_MONTHS].sort() : [];
  const expectedMonthDays = definition.job === "monthly" ? [String(definition.schedule.day_of_month)] : [];
  const triggerComparisons: { field: string; expected: string; actual: string }[] = [
    {
      field: "Trigger.Time",
      expected: expectedTrigger?.startTime ?? "<缺失>",
      actual: actualTrigger?.startTime ?? "<缺失>",
    },
    {
      field: "Trigger.Enabled",
      expected: expectedTrigger?.enabled ?? "<缺失>",
      actual: actualTrigger?.enabled ?? "<缺失>",
    },
    {
      field: "Trigger.Type",
      expected: definition.job === "monthly" ? "monthly" : "weekly",
      actual: actualTrigger?.kind ?? "<缺失>",
    },
    {
      field: "Trigger.Weekdays",
      expected: expectedDays.join(", ") || "<不适用>",
      actual: actualTrigger?.weekdays.join(", ") || "<不适用>",
    },
    {
      field: "Trigger.WeeksInterval",
      expected: definition.job === "monthly" ? "<不适用>" : "1",
      actual: definition.job === "monthly" ? "<不适用>" : (actualTrigger?.weeksInterval ?? "1"),
    },
    {
      field: "Trigger.MonthDays",
      expected: expectedMonthDays.join(", ") || "<不适用>",
      actual: actualTrigger?.monthDays.join(", ") || "<不适用>",
    },
    {
      field: "Trigger.Months",
      expected: expectedMonths.join(", ") || "<不适用>",
      actual: actualTrigger?.months.join(", ") || "<不适用>",
    },
  ];
  for (const comparison of triggerComparisons) {
    if (normalizedField(comparison.expected) !== normalizedField(comparison.actual)) differences.push(comparison);
  }
  return differences;
}

export function windowsTaskMatches(actualXml: string, definition: WindowsTaskDefinition): boolean {
  return windowsTaskDifferences(actualXml, definition).length === 0;
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
): Promise<WindowsTaskOperation[]> {
  const creates = operations.filter((operation) => operation.action === "create");
  const deletes = operations.filter((operation) => operation.action === "delete");
  const accessDenied: WindowsTaskOperation[] = [];
  let firstFailure: unknown;
  let hasFailure = false;

  for (const [group, action] of [
    [creates, "create"],
    [deletes, "delete"],
  ] as const) {
    await mapWithConcurrency(group, 4, async (operation, index) => {
      try {
        if (action === "delete") {
          await runner("schtasks.exe", ["/Delete", "/TN", operation.name, "/F"]).catch((error: unknown) => {
            if (!isWindowsTaskMissing(error)) throw error;
          });
          return;
        }
        if (!operation.xml) throw new Error(`任务 ${operation.name} 缺少 XML。`);
        const xmlPath = path.join(temporaryDirectory, `task-${index}.xml`);
        await writeFile(xmlPath, windowsTaskXmlBytes(operation.xml));
        await runner("schtasks.exe", ["/Create", "/TN", operation.name, "/XML", xmlPath, "/F"]);
      } catch (error) {
        if (isAccessDenied(error)) accessDenied.push(operation);
        else if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
        }
      }
    });
    if (hasFailure) throw firstFailure;
  }

  return accessDenied;
}

async function taskExists(name: string, runner: CommandRunner): Promise<boolean> {
  try {
    await runner("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
    return true;
  } catch (error) {
    if (isWindowsTaskMissing(error)) return false;
    throw error;
  }
}

function taskNameKey(taskName: string): string {
  return taskName.replace(/^\\+/, "").toLowerCase();
}

function parseWindowsCsvRows(output: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]!;
    if (character === '"') {
      if (inQuotes && output[index + 1] === '"') {
        field += '"';
        index += 1;
      } else inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if (character === "\n" && !inQuotes) {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r" || inQuotes) field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows.map((values) => values.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value)));
}

function isSiteIndexTaskName(name: string): boolean {
  return name.replace(/^\\+/, "").toLowerCase().startsWith("siteindex");
}

function taskNameColumn(row: string[]): number {
  // schtasks /V may prepend HostName before TaskName. Prefer the scheduler's
  // generated names, which have an explicit namespace separator.
  const generatedName = row.findIndex((value) => /^\\*siteindex(?:\\|\s+-\s+)/i.test(value.trim()));
  if (generatedName >= 0) return generatedName;
  return row.findIndex(isSiteIndexTaskName);
}

export function parseWindowsTaskNamesCsv(output: string): string[] {
  return parseWindowsCsvRows(output)
    .map((row) => row[taskNameColumn(row)]?.trim() ?? "")
    .filter(Boolean)
    .filter(isSiteIndexTaskName);
}

export function parseWindowsTaskRuntimeCsv(output: string): WindowsTaskRuntimeRow[] {
  return parseWindowsCsvRows(output)
    .map((row) => ({ row, nameIndex: taskNameColumn(row) }))
    .filter(({ row, nameIndex }) => nameIndex >= 0 && row[nameIndex]?.trim())
    .map(({ row, nameIndex }) => ({
      taskName: row[nameIndex]!.trim(),
      nextRunTime: row[nameIndex + 1]?.trim() || null,
      status: row[nameIndex + 2]?.trim() || null,
      lastRunTime: row[nameIndex + 4]?.trim() || null,
      lastResult: row[nameIndex + 5]?.trim() || null,
    }));
}

async function existingTaskNames(names: string[], runner: CommandRunner): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  try {
    const output = await runner("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"]);
    const existing = new Set(parseWindowsTaskNamesCsv(output).map(taskNameKey));
    return new Set(names.filter((name) => existing.has(taskNameKey(name))));
  } catch (error) {
    if (isWindowsTaskMissing(error)) return new Set();
    if (!isAccessDenied(error)) throw error;
    const results = await mapWithConcurrency(names, 4, async (name) => {
      try {
        return await taskExists(name, runner);
      } catch (queryError) {
        if (isAccessDenied(queryError)) return true;
        throw queryError;
      }
    });
    return new Set(names.filter((_name, index) => results[index]));
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
    async reconcile(desired, obsoleteNames, previousNames, allowElevation, previousMode, onTiming) {
      const definitions = new Map(
        desired.map((definition) => [windowsTaskName(definition.projectId, definition.job), definition]),
      );
      const desiredNames = [...definitions.keys()].sort();
      const desiredNameKeys = new Set(desiredNames.map(taskNameKey));
      const deleteNames = [...new Set([...previousNames, ...obsoleteNames])]
        .filter((name) => !desiredNameKeys.has(taskNameKey(name)))
        .sort();
      const namesInSystem = await measureSchedulerPhase(onTiming, "scheduler.task_list", () =>
        existingTaskNames(deleteNames, runner),
      );
      const operations: WindowsTaskOperation[] = [...namesInSystem].map((name) => ({ action: "delete", name }));
      const userId = definitions.size > 0 ? (options.userId ?? (await runner("whoami.exe", [])).trim()) : "";
      if (userId && !/^[^\\/\r\n]+\\[^\\/\r\n]+$/.test(userId)) {
        throw new Error("whoami 未返回计算机名\\用户名格式的当前用户。");
      }
      const createOperations: WindowsTaskOperation[] = [];
      const existingQueries = await measureSchedulerPhase(onTiming, "scheduler.task_query", () =>
        mapWithConcurrency([...definitions], 4, async ([name, definition]) => {
          try {
            const existingXml = await runner("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
            return { name, definition, existingXml };
          } catch (error) {
            if (isWindowsTaskMissing(error) || isAccessDenied(error)) return { name, definition, existingXml: null };
            throw error;
          }
        }),
      );
      const queryUserIds = existingQueries.map(({ existingXml }) => {
        if (!existingXml) return null;
        let taskUserId: string | null = null;
        try {
          taskUserId = windowsTaskUserId(existingXml);
        } catch {
          // 非法 XML 会由 windowsTaskMatches 报为字段差异并触发重新注册。
        }
        return taskUserId;
      });
      const hasSidTask = queryUserIds.some(isWindowsUserSid);
      const currentSid = hasSidTask
        ? (parseWindowsUserSid(await runner("whoami.exe", ["/user", "/fo", "csv", "/nh"])) ?? undefined)
        : undefined;
      for (let index = 0; index < existingQueries.length; index += 1) {
        const { name, definition, existingXml } = existingQueries[index]!;
        if (!existingXml || !windowsTaskMatches(existingXml, { ...definition, userId, userSid: currentSid })) {
          createOperations.push({ action: "create", name, xml: buildWindowsTaskXml({ ...definition, userId }) });
        }
      }

      const normalOperations: WindowsTaskOperation[] = [...createOperations, ...operations];
      let elevationOperations: WindowsTaskOperation[] = [];
      if (normalOperations.length > 0) {
        const directory = await mkdtemp(path.join(temporaryDirectory, "siteindex-schedule-"));
        try {
          elevationOperations = await measureSchedulerPhase(onTiming, "scheduler.task_apply", () =>
            applyNormalOperations(normalOperations, directory, runner),
          );
        } catch (error) {
          if (!isAccessDenied(error)) throw error;
          elevationOperations = normalOperations;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }

      if (elevationOperations.length > 0) {
        if (!allowElevation) {
          return {
            mode: previousMode ?? "system",
            authorization_required: true,
            registered_task_names: previousNames,
          };
        }
        const success = await measureSchedulerPhase(onTiming, "scheduler.elevation_wait", async () => {
          try {
            await options.beforeElevation?.();
          } catch {
            return false;
          }
          return applyElevated(elevationOperations);
        });
        if (!success) return { mode: "resident", authorization_required: true, registered_task_names: previousNames };
      }

      return { mode: "system", authorization_required: false, registered_task_names: desiredNames };
    },
  };
}
