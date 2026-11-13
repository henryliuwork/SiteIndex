import { createHash } from "node:crypto";
import { createServer, get as httpGet, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGscOAuthService } from "./gsc-oauth.js";
import type { SafeStorageAdapter } from "./wordpress-credential-vault.js";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SITES_ENDPOINT = "https://www.googleapis.com/webmasters/v3/sites";
const roots: string[] = [];
const servers: Server[] = [];

function fakeSafeStorage(): SafeStorageAdapter {
  const values = new Map<string, string>();
  let sequence = 0;
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plainText) => {
      const ciphertext = `fictional-ciphertext-${++sequence}`;
      values.set(ciphertext, plainText);
      return Buffer.from(ciphertext, "utf8");
    },
    decryptStringAsync: async (encrypted) => {
      const ciphertext = encrypted.toString("utf8");
      const value = values.get(ciphertext);
      if (!value) throw new Error("fictional decryption failure");
      return { result: value, shouldReEncrypt: false };
    },
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "siteindex-gsc-oauth-"));
  roots.push(directory);
  return directory;
}

async function callLocalCallback(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}

async function completeFictionalBrowserAuthorization(url: string): Promise<void> {
  const authorization = parseAuthorizationUrl(url);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "fictional-auth-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  await expect(callLocalCallback(callback)).resolves.toBe(200);
}

type RefreshBehavior = "success" | "invalid_grant" | "network";
type SitesBehavior = "success" | "network";

async function createLocalGoogleServices() {
  let refreshBehavior: RefreshBehavior = "success";
  let sitesBehavior: SitesBehavior = "success";
  const refreshRequests: URLSearchParams[] = [];
  const siteAuthorizationHeaders: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");

    if (request.method === "POST" && request.url === "/token") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "authorization_code") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "fictional-expired-access-token",
            refresh_token: "fictional-refresh-token",
            expires_in: 1,
            token_type: "Bearer",
            scope: GSC_SCOPE,
          }),
        );
        return;
      }
      refreshRequests.push(params);
      if (refreshBehavior === "network") {
        request.socket.destroy();
        return;
      }
      if (refreshBehavior === "invalid_grant") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "fictional-refreshed-access-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: GSC_SCOPE,
        }),
      );
      return;
    }

    if (request.method === "GET" && request.url === "/sites") {
      siteAuthorizationHeaders.push(String(request.headers.authorization ?? ""));
      if (sitesBehavior === "network") {
        request.socket.destroy();
        return;
      }
      if (request.headers.authorization !== "Bearer fictional-refreshed-access-token") {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          siteEntry: [
            { siteUrl: "sc-domain:fictional.example", permissionLevel: "siteOwner" },
            { siteUrl: "https://store.fictional.example/", permissionLevel: "siteFullUser" },
          ],
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fictional OAuth service failed to bind.");
  const localOrigin = `http://127.0.0.1:${address.port}`;

  return {
    refreshRequests,
    siteAuthorizationHeaders,
    setRefreshBehavior(value: RefreshBehavior) {
      refreshBehavior = value;
    },
    setSitesBehavior(value: SitesBehavior) {
      sitesBehavior = value;
    },
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestedUrl = String(input);
      if (requestedUrl === TOKEN_ENDPOINT) return globalThis.fetch(`${localOrigin}/token`, init);
      if (requestedUrl === SITES_ENDPOINT) return globalThis.fetch(`${localOrigin}/sites`, init);
      throw new Error("Unexpected fictional OAuth request endpoint.");
    },
  };
}

function parseAuthorizationUrl(url: string): URL {
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://accounts.google.com");
  expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
  return parsed;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("GSC read-only OAuth helper", () => {
  it("uses loopback + PKCE, encrypts fictional credentials, and clears them", async () => {
    const directory = await tempDirectory();
    const safeStorage = fakeSafeStorage();
    let authorization: URL | undefined;
    let tokenRequest: { url: string; init?: RequestInit } | undefined;
    const service = createGscOAuthService({
      clientId: "fictional-desktop-client-id.apps.exampleusercontent.test",
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage,
      now: () => 1_800_000_000_000,
      openExternal: async (url) => {
        authorization = parseAuthorizationUrl(url);
        const params = authorization.searchParams;
        expect(params.get("client_id")).toBe("fictional-desktop-client-id.apps.exampleusercontent.test");
        expect(params.get("scope")).toBe(GSC_SCOPE);
        expect(params.get("response_type")).toBe("code");
        expect(params.get("code_challenge_method")).toBe("S256");
        expect(params.get("access_type")).toBe("offline");
        expect(params.get("prompt")).toBe("consent");
        expect(params.has("client_secret")).toBe(false);

        const redirect = new URL(params.get("redirect_uri")!);
        expect(redirect.protocol).toBe("http:");
        expect(redirect.hostname).toBe("127.0.0.1");
        expect(redirect.port).not.toBe("");
        const callback = new URL(redirect);
        callback.searchParams.set("code", "fictional-auth-code");
        callback.searchParams.set("state", params.get("state")!);
        await expect(callLocalCallback(callback)).resolves.toBe(200);
      },
      fetchImpl: async (input, init) => {
        tokenRequest = { url: String(input), init };
        return new Response(
          JSON.stringify({
            access_token: "fictional-access-token",
            refresh_token: "fictional-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: GSC_SCOPE,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await service.authorize();

    expect(authorization).toBeDefined();
    expect(tokenRequest?.url).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = new URLSearchParams(String(tokenRequest?.init?.body));
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("client_id")).toBe("fictional-desktop-client-id.apps.exampleusercontent.test");
    expect(tokenBody.get("code")).toBe("fictional-auth-code");
    expect(tokenBody.has("client_secret")).toBe(false);
    const verifier = tokenBody.get("code_verifier")!;
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(challenge).toBe(authorization?.searchParams.get("code_challenge"));
    await expect(service.getCredentials()).resolves.toEqual({
      accessToken: "fictional-access-token",
      refreshToken: "fictional-refresh-token",
      tokenType: "Bearer",
      expiresAt: 1_800_003_600_000,
      scopes: [GSC_SCOPE],
    });

    const credentialFile = path.join(directory, "credentials", "gsc-oauth.v1.json");
    const persisted = await readFile(credentialFile, "utf8");
    expect(persisted).not.toContain("fictional-access-token");
    expect(persisted).not.toContain("fictional-refresh-token");
    expect(persisted).not.toContain("fictional-auth-code");
    await service.clear();
    await expect(service.getCredentials()).resolves.toBeNull();
    await expect(readFile(credentialFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not exchange or store tokens when the user cancels", async () => {
    const directory = await tempDirectory();
    let tokenRequests = 0;
    const service = createGscOAuthService({
      clientId: "fictional-client-id",
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage: fakeSafeStorage(),
      openExternal: async (url) => {
        const authorization = parseAuthorizationUrl(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        await expect(callLocalCallback(callback)).resolves.toBe(200);
      },
      fetchImpl: async () => {
        tokenRequests += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(service.authorize()).rejects.toMatchObject({ code: "CANCELLED" });
    expect(tokenRequests).toBe(0);
    await expect(service.getCredentials()).resolves.toBeNull();
  });

  it("keeps the store empty when the fictional token service fails", async () => {
    const directory = await tempDirectory();
    const service = createGscOAuthService({
      clientId: "fictional-client-id",
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage: fakeSafeStorage(),
      openExternal: async (url) => {
        const authorization = parseAuthorizationUrl(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "fictional-auth-code");
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        await expect(callLocalCallback(callback)).resolves.toBe(200);
      },
      fetchImpl: async () => new Response("fictional provider error", { status: 400 }),
    });

    await expect(service.authorize()).rejects.toMatchObject({ code: "TOKEN_EXCHANGE_FAILED" });
    await expect(service.getCredentials()).resolves.toBeNull();
  });

  it("requires an injected client ID and never assumes one exists", async () => {
    const directory = await tempDirectory();
    const service = createGscOAuthService({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage: fakeSafeStorage(),
      openExternal: async () => {
        throw new Error("must not open without configuration");
      },
    });
    await expect(service.authorize()).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });
  });

  it("refreshes an expired token before listing read-only Search Console properties", async () => {
    const directory = await tempDirectory();
    const localServices = await createLocalGoogleServices();
    const safeStorage = fakeSafeStorage();
    let clock = 1_800_000_000_000;
    const service = createGscOAuthService({
      clientId: "fictional-desktop-client-id",
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage,
      now: () => clock,
      openExternal: completeFictionalBrowserAuthorization,
      fetchImpl: localServices.fetchImpl,
    });

    await service.authorize();
    const original = await service.getCredentials();
    expect(original?.accessToken).toBe("fictional-expired-access-token");
    clock = original!.expiresAt + 1;

    await expect(service.listProperties()).resolves.toEqual([
      { siteUrl: "sc-domain:fictional.example", permissionLevel: "siteOwner" },
      { siteUrl: "https://store.fictional.example/", permissionLevel: "siteFullUser" },
    ]);
    expect(localServices.refreshRequests).toHaveLength(1);
    expect(localServices.refreshRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(localServices.refreshRequests[0]?.get("client_id")).toBe("fictional-desktop-client-id");
    expect(localServices.refreshRequests[0]?.get("refresh_token")).toBe("fictional-refresh-token");
    expect(localServices.refreshRequests[0]?.has("client_secret")).toBe(false);
    expect(localServices.siteAuthorizationHeaders).toEqual(["Bearer fictional-refreshed-access-token"]);
    await expect(service.getCredentials()).resolves.toMatchObject({
      accessToken: "fictional-refreshed-access-token",
      refreshToken: "fictional-refresh-token",
      scopes: [GSC_SCOPE],
    });
  });

  it("reports revoked authorization and preserves the encrypted credential on invalid_grant", async () => {
    const directory = await tempDirectory();
    const localServices = await createLocalGoogleServices();
    let clock = 1_800_000_000_000;
    const service = createGscOAuthService({
      clientId: "fictional-desktop-client-id",
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage: fakeSafeStorage(),
      now: () => clock,
      openExternal: completeFictionalBrowserAuthorization,
      fetchImpl: localServices.fetchImpl,
    });
    await service.authorize();
    const original = await service.getCredentials();
    clock = original!.expiresAt + 1;
    const credentialFile = path.join(directory, "credentials", "gsc-oauth.v1.json");
    const originalEnvelope = await readFile(credentialFile, "utf8");
    localServices.setRefreshBehavior("invalid_grant");

    await expect(service.listProperties()).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(service.getCredentials()).resolves.toEqual(original);
    await expect(readFile(credentialFile, "utf8")).resolves.toBe(originalEnvelope);
    expect(localServices.siteAuthorizationHeaders).toEqual([]);
  });

  it("preserves the original credential when refresh or property listing hits a network failure", async () => {
    const directory = await tempDirectory();
    const localServices = await createLocalGoogleServices();
    let clock = 1_800_000_000_000;
    const service = createGscOAuthService({
      clientId: "fictional-desktop-client-id",
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "credentials"),
      safeStorage: fakeSafeStorage(),
      now: () => clock,
      openExternal: completeFictionalBrowserAuthorization,
      fetchImpl: localServices.fetchImpl,
    });
    await service.authorize();
    const original = await service.getCredentials();
    clock = original!.expiresAt + 1;
    const credentialFile = path.join(directory, "credentials", "gsc-oauth.v1.json");
    const originalEnvelope = await readFile(credentialFile, "utf8");
    localServices.setRefreshBehavior("network");

    await expect(service.listProperties()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(readFile(credentialFile, "utf8")).resolves.toBe(originalEnvelope);
    await expect(service.getCredentials()).resolves.toEqual(original);

    localServices.setRefreshBehavior("success");
    localServices.setSitesBehavior("network");
    await expect(service.listProperties()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(readFile(credentialFile, "utf8")).resolves.toBe(originalEnvelope);
    await expect(service.getCredentials()).resolves.toEqual(original);
  });
});
