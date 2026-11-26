import { homedir } from "node:os";
import {
  isSiteIndexError,
  type ErrorDetail,
  type SiteIndexError,
} from "@siteindex/shared";

export interface CoreErrorLogEntry {
  code: SiteIndexError["code"];
  operation: string;
  stack: string;
}

export interface DiagnosticTextOptions {
  projectPath?: string;
  homeDirectory?: string;
  maxLength?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function pathPattern(value: string): RegExp | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parts = normalized.split(/[\\/]+/u).filter(Boolean);
  if (!parts.length) return undefined;
  const prefix = /^[\\/]{2}/u.test(normalized) ? "[\\\\/]{2}"
    : /^[\\/]/u.test(normalized) ? "[\\\\/]" : "";
  const body = parts.map(escapeRegExp).join("[\\\\/]+");
  return new RegExp(`${prefix}${body}(?=$|[\\\\/\\s\"',;:)])`, "giu");
}

/** Redacts user/project paths and credential-shaped values before diagnostics cross IPC or enter logs. */
export function redactDiagnosticText(value: string, options: DiagnosticTextOptions = {}): string {
  let safe = value;
  for (const [root, replacement] of [[options.projectPath, "~"], [options.homeDirectory ?? homedir(), "~"]] as const) {
    const pattern = root ? pathPattern(root) : undefined;
    if (pattern) safe = safe.replace(pattern, replacement);
  }

  safe = safe
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/giu, "$1=[REDACTED]")
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|token|password|passwd|secret|credential)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/giu, "$1[REDACTED]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9+/=_~.-]+/giu, "$1 [REDACTED]")
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/giu, "$1[REDACTED]@");

  const maxLength = Math.max(0, options.maxLength ?? 2048);
  return safe.length > maxLength ? safe.slice(0, maxLength) : safe;
}

function errorCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : undefined;
}

function isFilesystemError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "number";
}

function stackFrames(error: unknown, code: SiteIndexError["code"], operation: string): string {
  if (error instanceof Error && error.stack) {
    return error.stack.split(/\r?\n/u).slice(1).join("\n");
  }
  const generated = new Error(`${code} ${operation}`).stack;
  return generated?.split(/\r?\n/u).slice(1).join("\n") ?? `${code} ${operation}`;
}

export function describeOperationError(
  error: unknown,
  operation: string,
  projectPath?: string,
): { error: SiteIndexError; log: CoreErrorLogEntry } {
  const original: SiteIndexError = isSiteIndexError(error) && !isFilesystemError(error)
    ? error
    : {
      code: "WRITE_FAILED",
      message: "写入项目数据失败",
      ...(error instanceof Error ? { detail: error.message } : { detail: String(error) }),
    };
  const options = { projectPath };
  const safeDetail = original.detail === undefined
    ? undefined
    : redactDiagnosticText(original.detail, options);
  const prior = original.error_detail;
  const cause = prior?.cause ?? safeDetail ?? (error instanceof Error ? errorCode(error) ?? error.name : undefined);
  const errorDetail: ErrorDetail = {
    code: original.code,
    operation,
    ...(prior?.command ? { command: prior.command.map((part) => redactDiagnosticText(part, options)) } : {}),
    ...(prior?.exitCode !== undefined ? { exitCode: prior.exitCode } : {}),
    ...(prior?.stderr !== undefined ? { stderr: redactDiagnosticText(prior.stderr, { ...options, maxLength: 2048 }) } : {}),
    ...(cause ? { cause: redactDiagnosticText(cause, options) } : {}),
  };
  const safeError: SiteIndexError = {
    code: original.code,
    message: redactDiagnosticText(original.message, options),
    ...(safeDetail !== undefined ? { detail: safeDetail } : {}),
    error_detail: errorDetail,
  };
  const log: CoreErrorLogEntry = {
    code: original.code,
    operation,
    stack: redactDiagnosticText(stackFrames(error, original.code, operation), { ...options, maxLength: 8192 }),
  };
  return { error: safeError, log };
}
