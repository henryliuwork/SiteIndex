import { describe, expect, it, vi } from "vitest";
import type { SiteConfig } from "@siteindex/shared";
import { createApiBridge } from "../../preload/api.js";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import { GscOAuthError, type GscOAuthCredential, type GscOAuthService, type GscProperty } from "../gsc-oauth.js";
import { createIpcHandlerImplementations } from "./handlers.js";
import type { IpcContext } from "./context.js";

const FIXTURE_PROPERTY = "sc-domain:fictional.example.test";
const FIXTURE_PROPERTIES: GscProperty[] = [
  { siteUrl: FIXTURE_PROPERTY, permissionLevel: "siteOwner" },
  { siteUrl: "https://shop.fictional.example.test/", permissionLevel: "siteFullUser" },
];

function fixtureContext(clientIdConfigured = true) {
  let credentials: GscOAuthCredential | null = {
    accessToken: "fictional-access-token",
    refreshToken: "fictional-refresh-token",
    tokenType: "Bearer",
    expiresAt: 2_000_000_000_000,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  };
  let projectConfig = {
    integrations: {
      linkflow: { project: "fictional-linkflow-project" },
      gsc: { property_site_url: FIXTURE_PROPERTY, keep_fixture_value: true },
    },
  } as unknown as SiteConfig;
  const oauth: GscOAuthService = {
    authorize: vi.fn(async () => {
      credentials ??= {
        accessToken: "fictional-access-token",
        refreshToken: "fictional-refresh-token",
        tokenType: "Bearer",
        expiresAt: 2_000_000_000_000,
        scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      };
    }),
    getCredentials: vi.fn(async () => credentials),
    listProperties: vi.fn(async () => FIXTURE_PROPERTIES),
    clear: vi.fn(async () => {
      credentials = null;
    }),
  };
  const updateConfig = vi.fn(async (_id: string, patch: Partial<SiteConfig>) => {
    projectConfig = { ...projectConfig, ...patch } as SiteConfig;
    return projectConfig;
  });
  const context = {
    gscOAuth: oauth,
    gscClientIdConfigured: clientIdConfigured,
    withProject: async <T>(_value: unknown, callback: (id: string) => Promise<T>) => callback("fixture-project"),
    core: {
      projects: {
        get: vi.fn(async () => ({ config: projectConfig })),
        updateConfig,
      },
    },
  } as unknown as IpcContext;
  const implementations = createIpcHandlerImplementations(context);
  const registry = createHandlerRegistry(implementations);
  const bridge = createApiBridge({
    invoke: async (channel, ...args) => {
      const handler = registry.get(channel);
      if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    },
    listen: () => () => undefined,
  });

  return { bridge, context, implementations, oauth, updateConfig };
}

describe("GSC Desktop IPC and preload", () => {
  it("returns an understandable unconfigured state without opening the browser", async () => {
    const { bridge, oauth } = fixtureContext(false);

    await expect(bridge.gsc?.status()).resolves.toEqual({ state: "not_configured", reason: "client_id_missing" });
    await expect(bridge.gsc?.connect()).resolves.toEqual({ state: "not_configured", reason: "client_id_missing" });
    await expect(bridge.gsc?.listProperties("fixture-project")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "Google Search Console 尚未配置 OAuth 客户端 ID。",
    });
    expect(oauth.authorize).not.toHaveBeenCalled();
    expect(oauth.listProperties).not.toHaveBeenCalled();
  });

  it("exposes only authorization state when connecting and disconnecting", async () => {
    const { bridge, oauth } = fixtureContext();

    await expect(bridge.gsc?.status()).resolves.toEqual({ state: "connected" });
    await expect(bridge.gsc?.connect()).resolves.toEqual({ state: "connected" });
    await expect(bridge.gsc?.disconnect()).resolves.toEqual({ state: "disconnected" });
    expect(oauth.authorize).toHaveBeenCalledOnce();
    expect(oauth.clear).toHaveBeenCalledOnce();
    expect(JSON.stringify(await bridge.gsc?.status())).not.toContain("fictional-access-token");
    expect(JSON.stringify(await bridge.gsc?.status())).not.toContain("fictional-refresh-token");
  });

  it("returns only readable properties and safe provenance with the project's selected property", async () => {
    const { bridge, oauth } = fixtureContext();
    const result = await bridge.gsc?.listProperties("fixture-project");

    expect(result?.data).toEqual({
      properties: [
        { site_url: FIXTURE_PROPERTY, permission_level: "siteOwner" },
        { site_url: "https://shop.fictional.example.test/", permission_level: "siteFullUser" },
      ],
      selected_site_url: FIXTURE_PROPERTY,
    });
    expect(result?.metadata).toMatchObject({
      sources: [{ kind: "google_search_console", label: "Google Search Console" }],
      missing_fields: [],
      quality: "complete",
      anomalies: [],
    });
    expect(result?.metadata.collected_at).toMatch(/^\d{4}-\d\d-\d\dT/u);
    expect(JSON.stringify(result)).not.toContain("fictional-access-token");
    expect(JSON.stringify(result)).not.toContain("fictional-refresh-token");
    expect(oauth.listProperties).toHaveBeenCalledOnce();
  });

  it("reports reauthorization after an invalid grant without exposing the provider response", async () => {
    const { bridge, oauth } = fixtureContext();
    vi.mocked(oauth.listProperties).mockRejectedValue(new GscOAuthError("AUTHORIZATION_REQUIRED"));

    await expect(bridge.gsc?.listProperties("fixture-project")).rejects.toMatchObject({
      code: "UNKNOWN",
      message: "Google Search Console 授权已失效，请重新连接。",
    });
    await expect(bridge.gsc?.status()).resolves.toEqual({
      state: "reauthorization_required",
      reason: "refresh_token_rejected",
    });
  });

  it("reports unavailable local encryption without returning credential material", async () => {
    const { bridge, oauth } = fixtureContext();
    vi.mocked(oauth.getCredentials).mockRejectedValue(new GscOAuthError("ENCRYPTION_UNAVAILABLE"));

    await expect(bridge.gsc?.status()).resolves.toEqual({
      state: "unavailable",
      reason: "encryption_unavailable",
    });
  });

  it("selects only an available property and persists no OAuth material", async () => {
    const { bridge, oauth, updateConfig } = fixtureContext();

    await expect(
      bridge.gsc?.selectProperty("fixture-project", "https://shop.fictional.example.test/"),
    ).resolves.toEqual({
      site_url: "https://shop.fictional.example.test/",
    });
    expect(oauth.listProperties).toHaveBeenCalledOnce();
    expect(updateConfig).toHaveBeenCalledWith("fixture-project", {
      integrations: {
        linkflow: { project: "fictional-linkflow-project" },
        gsc: { property_site_url: "https://shop.fictional.example.test/", keep_fixture_value: true },
      },
    });
    expect(JSON.stringify(updateConfig.mock.calls)).not.toContain("fictional-access-token");
    expect(JSON.stringify(updateConfig.mock.calls)).not.toContain("fictional-refresh-token");
  });

  it("rejects properties outside the authorized list and allows clearing the selection", async () => {
    const { bridge, oauth, updateConfig } = fixtureContext();

    await expect(bridge.gsc?.selectProperty("fixture-project", "sc-domain:other.example.test")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "所选属性不在当前已授权账号的属性列表中。",
    });
    expect(updateConfig).not.toHaveBeenCalled();

    await expect(bridge.gsc?.selectProperty("fixture-project", null)).resolves.toEqual({ site_url: null });
    expect(oauth.listProperties).toHaveBeenCalledOnce();
    expect(updateConfig).toHaveBeenCalledWith("fixture-project", {
      integrations: {
        linkflow: { project: "fictional-linkflow-project" },
        gsc: { keep_fixture_value: true },
      },
    });
  });

  it("keeps sync as an explicit NOT_IMPLEMENTED pending IPC method", async () => {
    const { bridge, implementations } = fixtureContext();

    expect(implementations["gsc.sync"]).toBeUndefined();
    await expect(bridge.gsc?.sync("fixture-project", { mode: "initial_90_days" })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "该功能尚未实现",
    });
  });
});
