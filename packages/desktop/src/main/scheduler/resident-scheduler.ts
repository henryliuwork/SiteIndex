import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectId, ScheduleConfig } from "@siteindex/shared";
import { SCHEDULED_JOBS, scheduledOccurrenceKey, type ScheduledJob } from "./schedule.js";

export interface ResidentScheduleProject {
  id: ProjectId;
  path: string;
}

export interface ResidentScheduler {
  runDue(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface ResidentSchedulerOptions {
  statePath: string;
  intervalMs?: number;
  now?: () => Date;
  listProjects(): Promise<ResidentScheduleProject[]>;
  getSchedule(id: ProjectId): Promise<ScheduleConfig>;
  isThisDevice(id: ProjectId): Promise<boolean>;
  isJobRunning(id: ProjectId): Promise<boolean>;
  runJob(project: ResidentScheduleProject, job: ScheduledJob): Promise<unknown>;
}

type RunState = Record<string, string>;

const DEFAULT_INTERVAL_MS = 15_000;

function stateKey(projectId: ProjectId, job: ScheduledJob): string {
  return `${projectId}:${job}`;
}

async function readRunState(filePath: string): Promise<RunState> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    console.warn("读取常驻计划任务状态失败，将从空状态继续。", error);
    return {};
  }
}

async function writeRunState(filePath: string, state: RunState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export function createResidentScheduler(options: ResidentSchedulerOptions): ResidentScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const runningProjects = new Set<ProjectId>();
  let lastRuns: RunState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  async function runDue(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      lastRuns ??= await readRunState(options.statePath);
      const projects = await options.listProjects();
      const now = options.now?.() ?? new Date();

      for (const project of projects) {
        try {
          if (!(await options.isThisDevice(project.id))) continue;
          const config = await options.getSchedule(project.id);
          for (const job of SCHEDULED_JOBS) {
            const occurrence = scheduledOccurrenceKey(job, config, now);
            if (!occurrence || lastRuns[stateKey(project.id, job)] === occurrence) continue;
            if (runningProjects.has(project.id) || (await options.isJobRunning(project.id))) break;

            lastRuns[stateKey(project.id, job)] = occurrence;
            await writeRunState(options.statePath, lastRuns);
            runningProjects.add(project.id);
            void options
              .runJob(project, job)
              .catch((error) => console.error("常驻计划任务执行失败。", project.id, job, error))
              .finally(() => runningProjects.delete(project.id));
            break;
          }
        } catch (error) {
          console.error("检查项目计划任务失败。", project.id, error);
        }
      }
    } catch (error) {
      console.error("扫描常驻计划任务失败。", error);
    } finally {
      ticking = false;
    }
  }

  return {
    runDue,
    start() {
      if (timer) return;
      timer = setInterval(() => void runDue(), intervalMs);
      void runDue();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
