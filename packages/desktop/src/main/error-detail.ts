import type { ErrorDetail, SiteIndexError } from "@siteindex/shared";

export function redactDesktopDiagnosticText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]*/giu, "Authorization: [redacted]")
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/giu, "[redacted-cookie]")
    .replace(/\b(?:password|passwd|token|secret|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "[redacted]")
    .replace(/\b(?:basic|bearer)\s+[^\s]+/giu, "[redacted-auth]")
    .replace(/https?:\/\/[^\s"'()<>]+/giu, "[redacted-url]")
    .replace(/[A-Za-z]:\\Users\\[^\r\n"']+/giu, "~")
    .replace(/[A-Za-z]:\\[^\r\n"']+/gu, "[redacted-path]")
    .replace(/\/(?:Users|home)\/[^\r\n"']+/gu, "~")
    .replace(/\/(?:tmp|var|private|mnt)\/[^\r\n"']+/gu, "[redacted-path]");
}

const safeText = redactDesktopDiagnosticText;

function safeCommand(command: unknown): string[] | undefined {
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string") || command.length === 0) {
    return undefined;
  }
  return command.map((part: string, index: number) => {
    if (index === 0) return part.split(/[\\/]/u).at(-1) ?? "[command]";
    return /^(?:\/(?:Query|TN|XML|FO|V|NH|user|fo|nh)|-(?:NoProfile|NonInteractive|Command)|bootstrap|bootout|print|remove)$/iu
      .test(part) ? part : "[redacted]";
  });
}

export function sanitizeErrorDetail(value: unknown): ErrorDetail | undefined {
  if (!value || typeof value !== "object") return undefined;
  const detail = value as Record<string, unknown>;
  if (typeof detail.code !== "string" || typeof detail.operation !== "string") return undefined;
  const command = safeCommand(detail.command);
  const stderr = safeText(detail.stderr).slice(0, 2048);
  const cause = safeText(detail.cause).slice(0, 2048);
  return { code: safeText(detail.code), operation: safeText(detail.operation),
    ...(command ? { command } : {}),
    ...(typeof detail.exitCode === "number" ? { exitCode: detail.exitCode } : {}),
    ...(stderr ? { stderr } : {}), ...(cause ? { cause } : {}) };
}

export function scheduleErrorDetail(operation: string, error: unknown, fallbackCommand?: string[]): ErrorDetail {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rawExitCode = source.exitCode ?? source.code;
  const exitCode = typeof rawExitCode === "number" ? rawExitCode : undefined;
  const command = safeCommand(source.command ?? fallbackCommand);
  const stderr = safeText(source.stderr).slice(0, 2048);
  const cause = safeText(typeof source.message === "string" ? source.message : String(error)).slice(0, 2048);
  return {
    code: typeof source.code === "string" ? safeText(source.code) : "SCHEDULE_COMMAND_FAILED",
    operation,
    ...(command ? { command } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stderr ? { stderr } : {}),
    ...(cause ? { cause } : {}),
  };
}

export function scheduleIpcError(operation: string, error: unknown): SiteIndexError {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const hasCode = !(error instanceof Error) && typeof source.code === "string" && typeof source.message === "string";
  return {
    code: hasCode ? safeText(source.code) as SiteIndexError["code"] : "UNKNOWN",
    message: hasCode ? safeText(source.message) : "计划任务操作失败。",
    ...(typeof source.detail === "string" ? { detail: safeText(source.detail) } : {}),
    error_detail: sanitizeErrorDetail(source.error_detail) ?? scheduleErrorDetail(operation, error),
  };
}

export function settingsIpcError(operation: string, error: unknown): SiteIndexError {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const hasCode = !(error instanceof Error) && typeof source.code === "string" && typeof source.message === "string";
  const detail = sanitizeErrorDetail(source.error_detail) ?? sanitizeErrorDetail({
    code: typeof source.code === "string" ? source.code : "UNKNOWN",
    operation,
    command: source.command,
    exitCode: typeof source.exitCode === "number" ? source.exitCode : undefined,
    stderr: source.stderr,
    cause: typeof source.message === "string" ? source.message : String(error),
  });
  return {
    code: hasCode ? safeText(source.code) as SiteIndexError["code"] : "UNKNOWN",
    message: hasCode ? safeText(source.message) : "软件设置操作失败。",
    ...(typeof source.detail === "string" ? { detail: safeText(source.detail) } : {}),
    ...(detail ? { error_detail: detail } : {}),
  };
}
