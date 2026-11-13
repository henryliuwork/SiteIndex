import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGscOAuthService } from "./gsc-oauth.js";
import type { SafeStorageAdapter } from "./wordpress-credential-vault.js";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const roots: string[] = [];

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

function parseAuthorizationUrl(url: string): URL {
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://accounts.google.com");
  expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
  return parsed;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
});
