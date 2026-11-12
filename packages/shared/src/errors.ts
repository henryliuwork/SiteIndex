/** 命令行与 Job 退出码 */
export const EXIT = {
  OK: 0,
  VALIDATION_FAILED: 1,
  SOURCE_FAILED: 2,
  GUARD_ABORTED: 3,
  LOCKED: 4,
  NOT_RUNNER: 5,
  BAD_ARGS: 6,
  BROWSER_UNAVAILABLE: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type SiteIndexErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_UNREADABLE"
  | "PROJECT_CLOUD_SYNC_UNSUPPORTED"
  | "CONFIG_INVALID"
  | "FEED_FETCH_FAILED"
  | "FEED_EMPTY"
  | "GUARD_ABORTED"
  | "LOCKED"
  | "NOT_RUNNER"
  | "PATH_OUTSIDE_PROJECT"
  | "FOLDER_PROTECTED"
  | "FOLDER_EXISTS"
  | "WORKSPACE_NOT_EMPTY"
  | "BROWSER_UNAVAILABLE"
  | "CAPTCHA"
  | "WP_NOT_CONFIGURED"
  | "WP_AUTH_FAILED"
  | "WP_FORBIDDEN"
  | "WP_REST_UNREACHABLE"
  | "IMAGE_DECODE_FAILED"
  | "IMAGE_FETCH_FAILED"
  | "EDM_INDEX_CONFLICT"
  | "EDM_DISCOUNT_TIER_INVALID"
  | "EDM_EXPORT_OUTCOME_UNKNOWN"
  | "WRITE_FAILED"
  | "UNKNOWN";

/** 跨进程传递的错误（IPC 只能传可序列化对象） */
export interface SiteIndexError {
  code: SiteIndexErrorCode;
  message: string; // 面向用户的中文说明
  detail?: string;
}

export const isSiteIndexError = (e: unknown): e is SiteIndexError =>
  typeof e === "object" && e !== null && "code" in e && "message" in e;
