import type { JobResult, JobProgress } from "@siteindex/shared";
import type { WordPressCredential } from "../shared/wordpress-credential-types.js";

const CREDENTIAL_VALUE_PATTERN =
  /([?&](?:user(?:name)?|pass(?:word)?|app_password|application_password|token|secret|authorization)=)[^&#\s]*/gi;
const AUTH_HEADER_PATTERN = /(\b(?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;"']+/gi;
const AUTH_SCHEME_PATTERN = /\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USER_INFO_PATTERN = /(https?:\/\/)[^/@\s]+@/gi;

/** Redacts sensitive values and common HTTP credential formats from worker text. */
export function sanitizeWorkerText(value: string, sensitiveValues: readonly string[] = []): string {
  let safe = value;
  const variants = sensitiveValues.flatMap((secret) =>
    secret ? [secret, encodeURIComponent(secret), secret.replace(/\s+/g, "")] : [],
  );
  for (const secret of [...new Set(variants)].sort((left, right) => right.length - left.length)) {
    safe = safe.split(secret).join("[已隐藏]");
  }
  return safe
    .replace(CREDENTIAL_VALUE_PATTERN, "$1[已隐藏]")
    .replace(AUTH_HEADER_PATTERN, "$1[已隐藏]")
    .replace(AUTH_SCHEME_PATTERN, "$1 [已隐藏]")
    .replace(URL_USER_INFO_PATTERN, "$1[已隐藏]@");
}

/** In-memory redaction variants for WordPress Basic authentication; never persist this list. */
export function wordpressCredentialSensitiveValues(credential: WordPressCredential): string[] {
  const basicToken = Buffer.from(`${credential.username}:${credential.applicationPassword}`, "utf8").toString("base64");
  return [
    credential.username,
    credential.applicationPassword,
    `${credential.username}:${credential.applicationPassword}`,
    basicToken,
    `Basic ${basicToken}`,
  ];
}

export function sanitizeJobProgress(progress: JobProgress, sensitiveValues: readonly string[] = []): JobProgress {
  return sanitizeDeep(progress, sensitiveValues) as JobProgress;
}

export function sanitizeJobResult(result: JobResult, sensitiveValues: readonly string[] = []): JobResult {
  return sanitizeDeep(result, sensitiveValues) as JobResult;
}

function sanitizeDeep(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === "string") return sanitizeWorkerText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, sensitiveValues));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item, sensitiveValues)]));
  }
  return value;
}
