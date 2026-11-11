import type { SiteIndexErrorCode } from "./errors";
import type { JobName } from "./models";

export const JOB_NAMES: readonly JobName[] = [
  "daily",
  "weekly",
  "monthly",
  "validate",
  "readme",
  "design",
  "index-check",
  "views",
  "init",
  "media",
];

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
  /** media Job 选择处理的 SKU；其他 Job 忽略此字段。 */
  skus?: string[];
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
  /**
   * media 未中断地完成批次时，按请求顺序为每个 SKU 返回一条结果；单个 SKU 可失败而继续处理。
   * 401/403、取消或 worker 故障会提前终止：保留已完成结果，并可包含当前失败 SKU；尚未开始的 SKU 省略，表示未决。
   * 认证/权限终止通过 media_error_code 区分；此前至少有一项非失败 SKU 结果时为 partial，否则为 failed。
   * 通过 jobs.onFinished 按 runId 关联；原因须脱敏，且结果不得包含本机凭据。
   */
  media_results?: MediaPrepareSkuResult[];
  /** media 因 WordPress 认证失败或权限不足停批时，返回 WP_AUTH_FAILED / WP_FORBIDDEN。 */
  media_error_code?: Extract<SiteIndexErrorCode, "WP_AUTH_FAILED" | "WP_FORBIDDEN">;
}

export interface MediaPrepareSkuResult {
  sku: string;
  /** recorded 表示 jpg/png 原图 URL 直接写入台账，没有上传；skipped_has_url 表示台账原本已有 URL。 */
  status: "uploaded" | "reused" | "recorded" | "skipped_has_url" | "failed";
  /** 脱敏后的原因；不得包含凭据、授权头、口令或原始认证响应。 */
  reason?: string;
  image_url?: string;
}

/** 进度回调：core 的每个 Job 接收它；desktop 转发为 IPC 事件，cli 打印到终端 */
export type ProgressReporter = (p: Omit<JobProgress, "runId" | "projectPath" | "job" | "at">) => void;
