import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWordPressCredentialDirectory, type SafeStorageAdapter } from "./wordpress-credential-vault.js";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GSC_SITES_ENDPOINT = "https://www.googleapis.com/webmasters/v3/sites";
const GSC_READ_ONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const CALLBACK_PATH = "/";
const STORAGE_FILE_NAME = "gsc-oauth.v1.json";
const STORAGE_FORMAT_VERSION = 1;
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export interface GscOAuthCredential {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresAt: number;
  scopes: readonly [typeof GSC_READ_ONLY_SCOPE];
}

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscOAuthOptions {
  /** Public OAuth client ID supplied by a future app configuration; no client secret is accepted. */
  clientId?: string;
  platform: NodeJS.Platform;
  localAppData?: string;
  homeDirectory: string;
  safeStorage: SafeStorageAdapter;
  openExternal(url: string): Promise<void>;
  /** Test-only override. Production callers should use the platform-local directory. */
  directoryOverride?: string;
  /** Test-only adapter for exercising the token endpoint without contacting Google. */
  fetchImpl?: typeof fetch;
  /** Test-only timeout override. */
  authorizationTimeoutMs?: number;
  /** Test-only timeout override. */
  tokenTimeoutMs?: number;
  /** Test-only clock override. */
  now?: () => number;
}

export type GscOAuthErrorCode =
  | "CONFIGURATION_MISSING"
  | "AUTHORIZATION_IN_PROGRESS"
  | "BROWSER_OPEN_FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "AUTHORIZATION_FAILED"
  | "TOKEN_EXCHANGE_FAILED"
  | "NOT_CONFIGURED"
  | "AUTHORIZATION_REQUIRED"
  | "TOKEN_REFRESH_FAILED"
  | "NETWORK_ERROR"
  | "PROPERTY_LIST_FAILED"
  | "ENCRYPTION_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE";

const ERROR_MESSAGES: Record<GscOAuthErrorCode, string> = {
  CONFIGURATION_MISSING: "Google Search Console 尚未配置桌面 OAuth 客户端。",
  AUTHORIZATION_IN_PROGRESS: "Google Search Console 授权正在进行。",
  BROWSER_OPEN_FAILED: "无法打开系统浏览器。",
  CANCELLED: "用户取消了 Google Search Console 授权。",
  TIMEOUT: "等待 Google Search Console 授权超时。",
  AUTHORIZATION_FAILED: "Google Search Console 授权未完成。",
  TOKEN_EXCHANGE_FAILED: "无法安全完成 Google Search Console 凭据交换。",
  NOT_CONFIGURED: "尚未连接 Google Search Console。",
  AUTHORIZATION_REQUIRED: "Google Search Console 授权已失效，请重新授权。",
  TOKEN_REFRESH_FAILED: "无法刷新 Google Search Console 授权。",
  NETWORK_ERROR: "暂时无法连接 Google Search Console。",
  PROPERTY_LIST_FAILED: "无法读取 Google Search Console 属性列表。",
  ENCRYPTION_UNAVAILABLE: "本机安全存储暂不可用，凭据未保存。",
  STORAGE_UNAVAILABLE: "无法读取或保存本机加密凭据。",
};

export class GscOAuthError extends Error {
  constructor(readonly code: GscOAuthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "GscOAuthError";
  }
}

interface StoredEnvelope {
  version: number;
  ciphertext: string;
}

type LoopbackResult = { kind: "code"; code: string } | { kind: "cancelled" } | { kind: "failed" } | { kind: "timeout" };

interface LoopbackListener {
  redirectUri: string;
  waitForCallback(timeoutMs: number): Promise<LoopbackResult>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function safeStateEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function genericCallbackPage(): string {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>SiteIndex</title><body>授权流程已返回 SiteIndex，请关闭此页面并返回应用。</body></html>';
}

async function startLoopbackListener(expectedState: string): Promise<LoopbackListener> {
  let settleResult!: (result: LoopbackResult) => void;
  let resultSettled = false;
  const callbackResult = new Promise<LoopbackResult>((resolve) => {
    settleResult = (result) => {
      if (resultSettled) return;
      resultSettled = true;
      resolve(result);
    };
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string) => {
      response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
    };

    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      send(404, "Not found");
      return;
    }
    if (resultSettled) {
      send(410, "Authorization already completed");
      return;
    }

    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !safeStateEqual(expectedState, states[0] ?? "")) {
      send(400, "Authorization response rejected");
      return;
    }

    const errors = url.searchParams.getAll("error");
    const codes = url.searchParams.getAll("code");
    if (errors.length === 1 && errors[0] === "access_denied" && codes.length === 0) {
      send(200, genericCallbackPage());
      settleResult({ kind: "cancelled" });
      return;
    }
    if (errors.length !== 0 || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
      send(400, "Authorization response rejected");
      settleResult({ kind: "failed" });
      return;
    }

    send(200, genericCallbackPage());
    settleResult({ kind: "code", code: codes[0] });
  });

  server.on("error", () => settleResult({ kind: "failed" }));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new GscOAuthError("AUTHORIZATION_FAILED");
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}`,
    async waitForCallback(timeoutMs) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          callbackResult,
          new Promise<LoopbackResult>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

function credentialFromUnknown(value: unknown): GscOAuthCredential | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken ||
    value.tokenType !== "Bearer" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    !Array.isArray(value.scopes) ||
    value.scopes.length !== 1 ||
    value.scopes[0] !== GSC_READ_ONLY_SCOPE
  ) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    tokenType: "Bearer",
    expiresAt: value.expiresAt,
    scopes: [GSC_READ_ONLY_SCOPE],
  };
}

function extractCredential(response: unknown, now: number): GscOAuthCredential {
  if (!isRecord(response)) throw new GscOAuthError("TOKEN_EXCHANGE_FAILED");
  const scopes = typeof response.scope === "string" ? response.scope.trim().split(/\s+/).filter(Boolean) : [];
  const expiresIn = response.expires_in;
  if (
    typeof response.access_token !== "string" ||
    !response.access_token ||
    response.access_token.length > 16_384 ||
    typeof response.refresh_token !== "string" ||
    !response.refresh_token ||
    response.refresh_token.length > 16_384 ||
    response.token_type !== "Bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    scopes.length !== 1 ||
    scopes[0] !== GSC_READ_ONLY_SCOPE
  ) {
    throw new GscOAuthError("TOKEN_EXCHANGE_FAILED");
  }
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: "Bearer",
    expiresAt: now + expiresIn * 1000,
    scopes: [GSC_READ_ONLY_SCOPE],
  };
}

function extractRefreshedCredential(response: unknown, current: GscOAuthCredential, now: number): GscOAuthCredential {
  if (!isRecord(response)) throw new GscOAuthError("TOKEN_REFRESH_FAILED");
  const expiresIn = response.expires_in;
  const scopes =
    typeof response.scope === "string" ? response.scope.trim().split(/\s+/).filter(Boolean) : current.scopes;
  const refreshToken = typeof response.refresh_token === "string" ? response.refresh_token : current.refreshToken;
  if (
    typeof response.access_token !== "string" ||
    !response.access_token ||
    response.access_token.length > 16_384 ||
    !refreshToken ||
    refreshToken.length > 16_384 ||
    response.token_type !== "Bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    scopes.length !== 1 ||
    scopes[0] !== GSC_READ_ONLY_SCOPE
  ) {
    throw new GscOAuthError("TOKEN_REFRESH_FAILED");
  }
  return {
    accessToken: response.access_token,
    refreshToken,
    tokenType: "Bearer",
    expiresAt: now + expiresIn * 1000,
    scopes: [GSC_READ_ONLY_SCOPE],
  };
}

function parseGscProperties(value: unknown): GscProperty[] {
  if (!isRecord(value) || !Array.isArray(value.siteEntry)) throw new GscOAuthError("PROPERTY_LIST_FAILED");
  const properties: GscProperty[] = [];
  for (const entry of value.siteEntry) {
    if (
      !isRecord(entry) ||
      typeof entry.siteUrl !== "string" ||
      !entry.siteUrl ||
      typeof entry.permissionLevel !== "string" ||
      !entry.permissionLevel
    ) {
      throw new GscOAuthError("PROPERTY_LIST_FAILED");
    }
    properties.push({ siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel });
  }
  return properties;
}

async function responseIsInvalidGrant(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401) return false;
  try {
    const payload: unknown = await response.clone().json();
    return isRecord(payload) && payload.error === "invalid_grant";
  } catch {
    return false;
  }
}

/**
 * Main-process-only OAuth foundation. It has no IPC or UI registration by design.
 * Desktop OAuth clients are public clients: this service never accepts a client secret.
 */
export function createGscOAuthService(options: GscOAuthOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const pendingWrites = new Map<string, Promise<void>>();
  let authorizationInProgress = false;
  let propertiesRequest: Promise<GscProperty[]> | undefined;
  let accessTokenRequest: Promise<string> | undefined;
  let credentialRevision = 0;

  function credentialDirectory(): string {
    if (options.directoryOverride) return options.directoryOverride;
    return resolveWordPressCredentialDirectory(options);
  }

  function storagePath(): string {
    return path.join(credentialDirectory(), STORAGE_FILE_NAME);
  }

  async function ensureEncryption(): Promise<void> {
    try {
      if (await options.safeStorage.isAsyncEncryptionAvailable()) return;
    } catch {
      // Fail closed without exposing OS-specific encryption details.
    }
    throw new GscOAuthError("ENCRYPTION_UNAVAILABLE");
  }

  async function serializeWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
    const previous = pendingWrites.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    pendingWrites.set(filePath, current);
    try {
      await current;
    } finally {
      if (pendingWrites.get(filePath) === current) pendingWrites.delete(filePath);
    }
  }

  async function writeCredential(credential: GscOAuthCredential): Promise<void> {
    const filePath = storagePath();
    await serializeWrite(filePath, async () => {
      await ensureEncryption();
      let ciphertext: Buffer;
      try {
        ciphertext = await options.safeStorage.encryptStringAsync(JSON.stringify(credential));
      } catch {
        throw new GscOAuthError("ENCRYPTION_UNAVAILABLE");
      }
      const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(
          temporaryPath,
          JSON.stringify({ version: STORAGE_FORMAT_VERSION, ciphertext: ciphertext.toString("base64") }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await rename(temporaryPath, filePath);
      } catch {
        try {
          await unlink(temporaryPath);
        } catch {
          // Best effort; the temporary file contains encrypted data only.
        }
        throw new GscOAuthError("STORAGE_UNAVAILABLE");
      }
    });
  }

  async function readCredential(): Promise<GscOAuthCredential | null> {
    const filePath = storagePath();
    await pendingWrites.get(filePath)?.catch(() => undefined);
    await ensureEncryption();
    let envelopeText: string;
    try {
      envelopeText = await readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new GscOAuthError("STORAGE_UNAVAILABLE");
    }

    try {
      const envelope: unknown = JSON.parse(envelopeText);
      if (
        !isRecord(envelope) ||
        envelope.version !== STORAGE_FORMAT_VERSION ||
        typeof envelope.ciphertext !== "string" ||
        !envelope.ciphertext
      ) {
        throw new Error("invalid envelope");
      }
      const decrypted = await options.safeStorage.decryptStringAsync(Buffer.from(envelope.ciphertext, "base64"));
      const credential = credentialFromUnknown(JSON.parse(decrypted.result));
      if (!credential) throw new Error("invalid credential");
      if (decrypted.shouldReEncrypt) await writeCredential(credential);
      return credential;
    } catch (error) {
      if (error instanceof GscOAuthError) throw error;
      throw new GscOAuthError("STORAGE_UNAVAILABLE");
    }
  }

  async function exchangeCode(input: {
    code: string;
    redirectUri: string;
    verifier: string;
    clientId: string;
  }): Promise<GscOAuthCredential> {
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: input.clientId,
          code: input.code,
          code_verifier: input.verifier,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        }),
        signal: AbortSignal.timeout(options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new GscOAuthError("TOKEN_EXCHANGE_FAILED");
    }
    if (!response.ok) throw new GscOAuthError("TOKEN_EXCHANGE_FAILED");
    try {
      return extractCredential(await response.json(), now());
    } catch (error) {
      if (error instanceof GscOAuthError) throw error;
      throw new GscOAuthError("TOKEN_EXCHANGE_FAILED");
    }
  }

  async function refreshCredential(current: GscOAuthCredential): Promise<GscOAuthCredential> {
    const clientId = options.clientId?.trim();
    if (!clientId) throw new GscOAuthError("CONFIGURATION_MISSING");

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
        signal: AbortSignal.timeout(options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new GscOAuthError("NETWORK_ERROR");
    }

    if (!response.ok) {
      if (await responseIsInvalidGrant(response)) throw new GscOAuthError("AUTHORIZATION_REQUIRED");
      if (response.status === 429 || response.status >= 500) throw new GscOAuthError("NETWORK_ERROR");
      throw new GscOAuthError("TOKEN_REFRESH_FAILED");
    }
    try {
      return extractRefreshedCredential(await response.json(), current, now());
    } catch (error) {
      if (error instanceof GscOAuthError) throw error;
      throw new GscOAuthError("TOKEN_REFRESH_FAILED");
    }
  }

  async function requestProperties(accessToken: string): Promise<GscProperty[]> {
    let response: Response;
    try {
      response = await fetchImpl(GSC_SITES_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new GscOAuthError("NETWORK_ERROR");
    }
    if (response.status === 401) throw new GscOAuthError("AUTHORIZATION_REQUIRED");
    if (response.status === 429 || response.status >= 500) throw new GscOAuthError("NETWORK_ERROR");
    if (!response.ok) throw new GscOAuthError("PROPERTY_LIST_FAILED");
    try {
      return parseGscProperties(await response.json());
    } catch (error) {
      if (error instanceof GscOAuthError) throw error;
      throw new GscOAuthError("PROPERTY_LIST_FAILED");
    }
  }

  async function loadProperties(): Promise<GscProperty[]> {
    const revisionAtStart = credentialRevision;
    const current = await readCredential();
    if (!current) throw new GscOAuthError("NOT_CONFIGURED");

    const needsRefresh = current.expiresAt <= now() + ACCESS_TOKEN_REFRESH_SKEW_MS;
    const credential = needsRefresh ? await refreshCredential(current) : current;
    const properties = await requestProperties(credential.accessToken);
    if (needsRefresh && revisionAtStart === credentialRevision) await writeCredential(credential);
    return properties;
  }

  async function loadValidAccessToken(): Promise<string> {
    const revisionAtStart = credentialRevision;
    const current = await readCredential();
    if (!current) throw new GscOAuthError("NOT_CONFIGURED");
    if (current.expiresAt > now() + ACCESS_TOKEN_REFRESH_SKEW_MS) return current.accessToken;

    const refreshed = await refreshCredential(current);
    if (revisionAtStart !== credentialRevision) {
      const latest = await readCredential();
      if (!latest) throw new GscOAuthError("NOT_CONFIGURED");
      if (latest.expiresAt <= now() + ACCESS_TOKEN_REFRESH_SKEW_MS) throw new GscOAuthError("AUTHORIZATION_REQUIRED");
      return latest.accessToken;
    }
    await writeCredential(refreshed);
    return refreshed.accessToken;
  }

  return {
    async authorize(): Promise<void> {
      const clientId = options.clientId?.trim();
      if (!clientId) throw new GscOAuthError("CONFIGURATION_MISSING");
      if (authorizationInProgress) throw new GscOAuthError("AUTHORIZATION_IN_PROGRESS");
      authorizationInProgress = true;

      const { verifier, challenge } = createPkcePair();
      const state = randomBytes(32).toString("base64url");
      let listener: LoopbackListener | undefined;
      try {
        try {
          listener = await startLoopbackListener(state);
        } catch (error) {
          if (error instanceof GscOAuthError) throw error;
          throw new GscOAuthError("AUTHORIZATION_FAILED");
        }
        const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
        authorizationUrl.search = new URLSearchParams({
          access_type: "offline",
          client_id: clientId,
          code_challenge: challenge,
          code_challenge_method: "S256",
          prompt: "consent",
          redirect_uri: listener.redirectUri,
          response_type: "code",
          scope: GSC_READ_ONLY_SCOPE,
          state,
        }).toString();

        try {
          await options.openExternal(authorizationUrl.toString());
        } catch {
          throw new GscOAuthError("BROWSER_OPEN_FAILED");
        }

        const result = await listener.waitForCallback(
          options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS,
        );
        if (result.kind === "timeout") throw new GscOAuthError("TIMEOUT");
        if (result.kind === "cancelled") throw new GscOAuthError("CANCELLED");
        if (result.kind !== "code") throw new GscOAuthError("AUTHORIZATION_FAILED");

        const credential = await exchangeCode({
          code: result.code,
          redirectUri: listener.redirectUri,
          verifier,
          clientId,
        });
        credentialRevision += 1;
        await writeCredential(credential);
      } finally {
        await listener?.close();
        authorizationInProgress = false;
      }
    },

    /** Main-process-only accessor for future GSC Core requests. Never expose via IPC/preload. */
    getCredentials(): Promise<GscOAuthCredential | null> {
      return readCredential();
    },

    /** Main-process-only access token accessor; refreshes near-expiry credentials before returning. */
    getValidAccessToken(): Promise<string> {
      if (accessTokenRequest) return accessTokenRequest;
      let request!: Promise<string>;
      request = loadValidAccessToken().finally(() => {
        if (accessTokenRequest === request) accessTokenRequest = undefined;
      });
      accessTokenRequest = request;
      return request;
    },

    /** Read-only Search Console sites.list; refreshed credentials commit only after the list succeeds. */
    listProperties(): Promise<GscProperty[]> {
      if (propertiesRequest) return propertiesRequest;
      const current = loadProperties();
      propertiesRequest = current;
      return current.finally(() => {
        if (propertiesRequest === current) propertiesRequest = undefined;
      });
    },

    /** Remove the encrypted local credential without contacting Google. */
    async clear(): Promise<void> {
      credentialRevision += 1;
      const filePath = storagePath();
      await serializeWrite(filePath, async () => {
        try {
          await unlink(filePath);
        } catch (error) {
          if (!isMissingFile(error)) throw new GscOAuthError("STORAGE_UNAVAILABLE");
        }
      });
    },
  };
}

export type GscOAuthService = ReturnType<typeof createGscOAuthService>;
