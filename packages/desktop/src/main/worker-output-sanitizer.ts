import type { JobResult, JobProgress } from "@siteindex/shared";
import type { WordPressCredential } from "../shared/wordpress-credential-types.js";

const CREDENTIAL_VALUE_PATTERN =
  /([?&](?:pass(?:word)?|app_password|application_password|token|secret|authorization)=)[^&#\s]*/gi;
const USERNAME_QUERY_VALUE_PATTERN = /([?&](?:user(?:name)?)=)[^&#\s]*/gi;
const AUTH_HEADER_PATTERN = /(\b(?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;"']+/gi;
const AUTH_SCHEME_PATTERN = /\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USER_INFO_PATTERN = /(https?:\/\/)[^/@\s]+@/gi;
const TEXT_FIELDS = new Set(["message", "summary", "reason", "error", "errors", "detail", "description", "notes"]);

/** Redacts sensitive values and common HTTP credential formats from worker text. */
export function sanitizeWorkerText(
  value: string,
  sensitiveValues: readonly string[] = [],
  sensitiveUsernames: readonly string[] = [],
  redactUsernameQuery = true,
): string {
  let safe = value;
  const variants = sensitiveValues.flatMap((secret) =>
    secret ? [secret, encodeURIComponent(secret), secret.replace(/\s+/g, "")] : [],
  );
  for (const secret of [...new Set(variants)].sort((left, right) => right.length - left.length)) {
    safe = safe.split(secret).join("[已隐藏]");
  }
  safe = safe
    .replace(CREDENTIAL_VALUE_PATTERN, "$1[已隐藏]")
    .replace(AUTH_HEADER_PATTERN, "$1[已隐藏]")
    .replace(AUTH_SCHEME_PATTERN, "$1 [已隐藏]")
    .replace(URL_USER_INFO_PATTERN, "$1[已隐藏]@");
  if (redactUsernameQuery) safe = safe.replace(USERNAME_QUERY_VALUE_PATTERN, "$1[已隐藏]");
  return redactUsernameTokens(safe, sensitiveUsernames);
}

function redactUsernameTokens(value: string, usernames: readonly string[]): string {
  let safe = value;
  const escapedUsernames = [...new Set(usernames.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((username) => username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  for (const username of escapedUsernames) {
    const tokenPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${username}(?![\\p{L}\\p{N}_])`, "giu");
    safe = safe.replace(tokenPattern, "[已隐藏]");
  }
  return safe;
}

/** In-memory redaction variants for WordPress Basic authentication; never persist this list. */
export function wordpressCredentialSensitiveValues(credential: WordPressCredential): string[] {
  const basicToken = Buffer.from(`${credential.username}:${credential.applicationPassword}`, "utf8").toString("base64");
  return [
    credential.applicationPassword,
    `${credential.username}:${credential.applicationPassword}`,
    basicToken,
    `Basic ${basicToken}`,
  ];
}

/** Usernames are identities, so only redact them in unstructured text fields. */
export function wordpressCredentialUsernames(credential: WordPressCredential): string[] {
  return credential.username ? [credential.username] : [];
}

export function sanitizeJobProgress(
  progress: JobProgress,
  sensitiveValues: readonly string[] = [],
  sensitiveUsernames: readonly string[] = [],
): JobProgress {
  return sanitizeDeep(progress, sensitiveValues, sensitiveUsernames) as JobProgress;
}

export function sanitizeJobResult(
  result: JobResult,
  sensitiveValues: readonly string[] = [],
  sensitiveUsernames: readonly string[] = [],
): JobResult {
  return sanitizeDeep(result, sensitiveValues, sensitiveUsernames) as JobResult;
}

function sanitizeDeep(
  value: unknown,
  sensitiveValues: readonly string[],
  sensitiveUsernames: readonly string[],
  redactUsernameTokens = false,
  redactUsernameQuery = false,
): unknown {
  if (typeof value === "string") {
    return sanitizeWorkerText(
      value,
      sensitiveValues,
      redactUsernameTokens ? sensitiveUsernames : [],
      redactUsernameQuery,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeDeep(item, sensitiveValues, sensitiveUsernames, redactUsernameTokens, redactUsernameQuery),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDeep(
          item,
          sensitiveValues,
          sensitiveUsernames,
          TEXT_FIELDS.has(key.toLowerCase()),
          TEXT_FIELDS.has(key.toLowerCase()) || key.toLowerCase() === "url" || key.toLowerCase().endsWith("_url"),
        ),
      ]),
    );
  }
  return value;
}
