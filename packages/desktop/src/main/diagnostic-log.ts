import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CoreServiceContext } from "@siteindex/core";
import { redactDesktopDiagnosticText } from "./error-detail.js";

type ErrorLogEntry = Parameters<NonNullable<CoreServiceContext["logError"]>>[0];

export function desktopErrorLogEntry(operation: string, error: unknown): ErrorLogEntry {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const stack = error instanceof Error && error.stack ? error.stack : new Error(operation).stack ?? operation;
  return {
    code: typeof source.code === "string" ? redactDesktopDiagnosticText(source.code) as ErrorLogEntry["code"] : "UNKNOWN",
    operation,
    stack: redactDesktopDiagnosticText(stack).slice(0, 8192),
  };
}

/** Core errors are written only to the local app log, never to the IPC payload. */
export function createCoreErrorLogger(
  logDirectory: string,
  append: (path: string, line: string) => Promise<unknown> = appendFile,
): NonNullable<CoreServiceContext["logError"]> {
  return (entry) => {
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      code: redactDesktopDiagnosticText(entry.code),
      operation: redactDesktopDiagnosticText(entry.operation),
      stack: redactDesktopDiagnosticText(entry.stack).slice(0, 8192),
    })}\n`;
    void mkdir(logDirectory, { recursive: true })
      .then(() => append(join(logDirectory, "siteindex-errors.log"), line))
      .catch(() => undefined); // Logging failure must not replace the original operation error.
  };
}
