import type { JobName } from "./models";

export const JOB_NAMES: readonly JobName[] = ["daily", "weekly", "monthly", "validate", "readme", "design", "index-check", "views", "init"];

/** 新建项目流程的进度步骤，由 Core 执行除 schedule 外的步骤。 */
export const INIT_STEPS = ["folders", "config", "readme", "skills", "daily", "weekly", "views", "schedule"] as const;
export type InitStepKey = (typeof INIT_STEPS)[number];

/** 定时计划可配置的任务 */
export const SCHEDULABLE_JOBS = ["daily", "validate", "weekly", "readme", "monthly"] as const;
export type SchedulableJob = (typeof SCHEDULABLE_JOBS)[number];

export type JobTrigger = "schedule" | "manual" | "cli";

export interface JobRequest {
  projectPath: string;
  job: JobName;
  trigger: JobTrigger;
  /** 只执行某个步骤，如 weekly 的 "links"（用于"重新生成"单个文件） */
  only?: string;
  /** 指定业务日期（测试用） */
  date?: string;
  force?: boolean;
  dryRun?: boolean;
}

export type JobLogLevel = "info" | "warn" | "error";

export interface JobProgress {
  runId: string;
  projectPath: string;
  job: JobName;
  /** 0–100；未知时为 null */
  pct: number | null;
  /** init 任务使用 INIT_STEPS 中的 key；其他任务使用各自的步骤名。 */
  step?: string;
  level: JobLogLevel;
  message: string;
  at: string;
}

export interface JobResult {
  runId: string;
  job: JobName;
  status: "ok" | "partial" | "failed" | "skipped";
  exitCode: number;
  summary: string;
  counts?: Record<string, number>;
  errors?: string[];
  /** init 任务逐步结果；schedule 由 Desktop 执行。 */
  steps?: { key: string; status: "ok" | "failed" | "skipped"; message?: string }[];
}

/** 进度回调：core 的每个 Job 接收它；desktop 转发为 IPC 事件，cli 打印到终端 */
export type ProgressReporter = (p: Omit<JobProgress, "runId" | "projectPath" | "job" | "at">) => void;
