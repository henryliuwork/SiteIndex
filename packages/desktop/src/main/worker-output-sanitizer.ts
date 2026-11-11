import type { JobResult, JobProgress } from "@siteindex/shared";
import type { WordPressCredential } from "../shared/wordpress-credential-types.js";

const CREDENTIAL_VALUE_PATTERN =
  /([?&](?:pass(?:word)?|app_password|application_password|token|secret|authorization)=)[^&#\s]*/gi;
const USERNAME_QUERY_VALUE_PATTERN = /([?&](?:user(?:name)?)=)([^&#\s]*)/gi;
const AUTH_HEADER_PATTERN = /(\b(?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;"']+/gi;
const AUTH_SCHEME_PATTERN = /\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USER_INFO_PATTERN = /(https?:\/\/)[^/@\s]+@/gi;
const URL_TEXT_PATTERN = /(?:https?:\/\/|https?%3A%2F%2F)[^\s"'<>]+/gi;
const TEXT_FIELDS = new Set(["message", "summary", "reason", "error", "errors", "detail", "description", "notes"]);

/** Redacts sensitive values and common HTTP credential formats from worker text. */
export function sanitizeWorkerText(
  value: string,
  sensitiveValues: readonly string[] = [],
  sensitiveUsernames: readonly string[] = [],
): string {
  return sanitizeString(value, sensitiveValues, sensitiveUsernames, "text");
}

type FieldContext = "text" | "url" | "structured";

function sanitizeString(
  value: string,
  sensitiveValues: readonly string[],
  sensitiveUsernames: readonly string[],
  context: FieldContext,
): string {
  let safe = value;
  if (context === "url") safe = redactUrlUsernames(safe, sensitiveUsernames);
  else if (context === "text") safe = redactUrlsInText(safe, sensitiveUsernames);
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
  if (context !== "text") return safe;
  safe = safe.replace(USERNAME_QUERY_VALUE_PATTERN, (match, label: string, queryValue: string) =>
    matchesUsername(queryValue, sensitiveUsernames) ? `${label}[已隐藏]` : match,
  );
  return redactUsernameTokensOutsideUrls(safe, sensitiveUsernames);
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

function decodeRepeatedly(value: string): string {
  let decoded = value;
  for (let index = 0; index < 4; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function matchesUsername(value: string, usernames: readonly string[]): boolean {
  const decoded = decodeRepeatedly(value).toLowerCase();
  return usernames.some((username) => username && decoded === decodeRepeatedly(username).toLowerCase());
}

function redactUrlUsernames(value: string, usernames: readonly string[]): string {
  if (usernames.length === 0) return value;

  let source = value;
  let encodedLayers = 0;
  while (encodedLayers < 3 && /^https?%3a%2f%2f/i.test(source)) {
    try {
      source = decodeURIComponent(source);
      encodedLayers += 1;
    } catch {
      break;
    }
  }

  const isAbsolute = /^https?:\/\//i.test(source);
  const isProtocolRelative = source.startsWith("//");
  let url: URL;
  try {
    url = new URL(source, "https://siteindex.invalid");
  } catch {
    return value;
  }

  let changed = false;
  const pathSegments = url.pathname.split("/");
  for (let index = 0; index < pathSegments.length; index += 1) {
    if (matchesUsername(pathSegments[index] ?? "", usernames)) {
      pathSegments[index] = encodeURIComponent("[已隐藏]");
      changed = true;
    }
  }
  if (changed) url.pathname = pathSegments.join("/");

  const queryEntries = [...url.searchParams.entries()];
  const nextQuery = new URLSearchParams();
  for (const [key, queryValue] of queryEntries) {
    if (matchesUsername(queryValue, usernames)) {
      nextQuery.append(key, "[已隐藏]");
      changed = true;
    } else {
      nextQuery.append(key, queryValue);
    }
  }
  if (changed && queryEntries.length > 0) url.search = nextQuery.toString();
  if (!changed) return value;

  const pathAndQuery = `${url.pathname}${url.search}${url.hash}`;
  let redacted = isAbsolute
    ? `${url.protocol}//${url.host}${pathAndQuery}`
    : isProtocolRelative
      ? `//${url.host}${pathAndQuery}`
      : pathAndQuery;
  for (let index = 0; index < encodedLayers; index += 1) redacted = encodeURIComponent(redacted);
  return redacted;
}

function redactUrlsInText(value: string, usernames: readonly string[]): string {
  let result = "";
  let lastIndex = 0;
  for (const match of value.matchAll(URL_TEXT_PATTERN)) {
    const index = match.index ?? 0;
    const candidate = match[0];
    const trailingPunctuation = candidate.match(/[),.!;]+$/)?.[0] ?? "";
    const urlText = trailingPunctuation ? candidate.slice(0, -trailingPunctuation.length) : candidate;
    result += value.slice(lastIndex, index);
    result += redactUrlUsernames(urlText, usernames);
    result += trailingPunctuation;
    lastIndex = index + candidate.length;
  }
  return result + value.slice(lastIndex);
}

function redactUsernameTokensOutsideUrls(value: string, usernames: readonly string[]): string {
  let result = "";
  let lastIndex = 0;
  for (const match of value.matchAll(URL_TEXT_PATTERN)) {
    const index = match.index ?? 0;
    const candidate = match[0];
    result += redactUsernameTokens(value.slice(lastIndex, index), usernames);
    result += candidate;
    lastIndex = index + candidate.length;
  }
  return result + redactUsernameTokens(value.slice(lastIndex), usernames);
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
    const context: FieldContext = redactUsernameTokens ? "text" : redactUsernameQuery ? "url" : "structured";
    return sanitizeString(
      value,
      sensitiveValues,
      redactUsernameTokens || redactUsernameQuery ? sensitiveUsernames : [],
      context,
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
