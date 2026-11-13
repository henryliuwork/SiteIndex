import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncProjectSearchAnalytics, type GscProjectSyncOptions } from "@siteindex/core";
import { PATHS, type GscSyncInput, type GscSyncResult, type SiteConfig } from "@siteindex/shared";
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

function syncResult(
  mode: GscSyncInput["mode"],
  property: string | null,
  state: "complete" | "blocked",
  code?: string,
  message?: string,
): GscSyncResult {
  const metadata = {
    data_source: "google_search_console" as const,
    property_site_url: property,
    requested_at: "2026-11-13T00:00:00.000Z",
    collected_at: state === "complete" ? "2026-11-13T00:00:00.000Z" : null,
    data_through: state === "complete" ? "2026-11-12" : null,
    requested_range: null,
    missing_ranges: [],
    missing_fields: [],
    quality: state === "complete" ? "complete" as const : "partial" as const,
    anomalies: code && message ? [{ code, severity: "warning" as const, message }] : [],
  };
  if (state === "complete") {
    return { state, mode, records_received: 1, records_written: 1, history_effect: "merged", metadata };
  }
  return {
    state,
    mode,
    records_received: 0,
    records_written: 0,
    history_effect: "preserved",
    metadata,
    error: { code: code ?? "GSC_BLOCKED", message: message ?? "同步暂不可用。" },
  };
}

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
  const syncGsc = vi.fn(async (
    _projectPath: string,
    input: GscSyncInput,
    options: GscProjectSyncOptions,
  ): Promise<GscSyncResult> => {
    if (!options.property) return syncResult(input.mode, null, "blocked", "GSC_PROPERTY_REQUIRED", "请先选择 Search Console 属性。");
    if (!options.accessToken) return syncResult(input.mode, options.property, "blocked", "GSC_AUTH_REQUIRED", "请先连接 Google 账户。");
    return syncResult(input.mode, options.property, "complete");
  });
  const context = {
    gscOAuth: oauth,
    gscClientIdConfigured: clientIdConfigured,
    withProject: async <T>(_value: unknown, callback: (id: string) => Promise<T>) => callback("fixture-project"),
    projects: { resolveProject: vi.fn(() => "C:\\Fictional\\projects\\fixture-project") },
    core: {
      projects: {
        get: vi.fn(async () => ({ config: projectConfig })),
        updateConfig,
      },
    },
    syncGscProjectSearchAnalytics: syncGsc,
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

  return { bridge, context, implementations, oauth, syncGsc, updateConfig };
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

  it("syncs selected property analytics through Core without returning credentials", async () => {
    const { bridge, syncGsc } = fixtureContext();

    await expect(bridge.gsc?.sync("fixture-project", { mode: "initial_90_days" })).resolves.toMatchObject({
      state: "complete",
      mode: "initial_90_days",
      history_effect: "merged",
      records_written: 1,
      metadata: { property_site_url: FIXTURE_PROPERTY },
    });
    expect(syncGsc).toHaveBeenCalledWith(
      "C:\\Fictional\\projects\\fixture-project",
      { mode: "initial_90_days" },
      { property: FIXTURE_PROPERTY, accessToken: "fictional-access-token" },
    );
    const result = await bridge.gsc?.sync("fixture-project", { mode: "incremental" });
    expect(result?.mode).toBe("incremental");
    expect(JSON.stringify(result)).not.toContain("fictional-access-token");
    expect(JSON.stringify(result)).not.toContain("fictional-refresh-token");
  });

  it("writes fixture sync results to the local project history and preserves them after disconnect", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "siteindex-gsc-ipc-"));
    let server: Server | null = null;
    try {
      await mkdir(path.dirname(path.join(projectPath, PATHS.site)), { recursive: true });
      await writeFile(path.join(projectPath, PATHS.site), "{}\n", "utf8");
      server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          const payload = JSON.parse(body) as { dimensions: string[] };
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ rows: payload.dimensions.length === 1
            ? [{ keys: ["2026-11-12"] }]
            : [{ keys: ["2026-11-12", "https://shop.fictional.example.test/item", "fictional-query"], clicks: 2, impressions: 5, ctr: 0.4, position: 3 }] }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture GSC service unavailable");
      const apiBaseUrl = `http://127.0.0.1:${address.port}`;
      const { bridge, context, syncGsc } = fixtureContext();
      vi.mocked(context.projects.resolveProject).mockReturnValue(projectPath);
      syncGsc.mockImplementation((resolvedProjectPath, input, options: GscProjectSyncOptions) =>
        syncProjectSearchAnalytics(resolvedProjectPath, input, {
          ...options,
          now: new Date("2026-11-13T12:00:00.000Z"),
          apiBaseUrl,
        }));

      const result = await bridge.gsc?.sync("fixture-project", { mode: "initial_90_days" });
      expect(result).toMatchObject({
        state: "partial",
        history_effect: "merged",
        records_received: 1,
        records_written: 1,
        metadata: { property_site_url: FIXTURE_PROPERTY },
      });
      const historyPath = path.join(projectPath, PATHS.gscSearchAnalytics);
      const savedHistory = await readFile(historyPath, "utf8");
      expect(savedHistory).toContain("fictional-query");
      expect(savedHistory).not.toContain("fictional-access-token");
      await expect(bridge.gsc?.disconnect()).resolves.toEqual({ state: "disconnected" });
      await expect(readFile(historyPath, "utf8")).resolves.toBe(savedHistory);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns Core blocked states when property selection or authorization is missing", async () => {
    const { bridge, context, oauth, syncGsc } = fixtureContext();

    vi.mocked(context.core.projects.get).mockResolvedValue({ config: {} } as never);
    await expect(bridge.gsc?.sync("fixture-project", { mode: "initial_90_days" })).resolves.toMatchObject({
      state: "blocked",
      error: { code: "GSC_PROPERTY_REQUIRED" },
      history_effect: "preserved",
    });
    expect(syncGsc).toHaveBeenCalledWith(
      "C:\\Fictional\\projects\\fixture-project",
      { mode: "initial_90_days" },
      { property: null, accessToken: "" },
    );

    vi.mocked(context.core.projects.get).mockResolvedValue({ config: { integrations: { gsc: { property_site_url: FIXTURE_PROPERTY } } } } as never);
    vi.mocked(oauth.getCredentials).mockResolvedValue(null);
    await expect(bridge.gsc?.sync("fixture-project", { mode: "incremental" })).resolves.toMatchObject({
      state: "blocked",
      error: { code: "GSC_AUTH_REQUIRED" },
      history_effect: "preserved",
    });
  });

  it("returns a reauthorization state when sync credentials have expired", async () => {
    const { bridge, oauth, syncGsc } = fixtureContext();
    vi.mocked(oauth.getCredentials).mockRejectedValue(new GscOAuthError("AUTHORIZATION_REQUIRED"));

    await expect(bridge.gsc?.sync("fixture-project", { mode: "incremental" })).resolves.toMatchObject({
      state: "blocked",
      error: { code: "GSC_REAUTHORIZATION_REQUIRED" },
      history_effect: "preserved",
    });
    await expect(bridge.gsc?.status()).resolves.toEqual({
      state: "reauthorization_required",
      reason: "refresh_token_rejected",
    });
    expect(syncGsc).not.toHaveBeenCalled();
  });

  it("rejects invalid sync modes and prevents overlapping syncs for the same project", async () => {
    const { bridge, implementations, syncGsc } = fixtureContext();
    await expect(implementations["gsc.sync"]?.("fixture-project", { mode: "unknown" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "Search Console 同步模式无效。",
    });

    let resolveSync!: (result: GscSyncResult) => void;
    syncGsc.mockImplementationOnce(() => new Promise((resolve) => { resolveSync = resolve; }));
    const first = bridge.gsc?.sync("fixture-project", { mode: "initial_90_days" });
    await vi.waitFor(() => expect(syncGsc).toHaveBeenCalledOnce());
    await expect(bridge.gsc?.sync("fixture-project", { mode: "incremental" })).resolves.toMatchObject({
      state: "blocked",
      error: { code: "GSC_SYNC_IN_PROGRESS" },
      history_effect: "preserved",
    });
    resolveSync(syncResult("initial_90_days", FIXTURE_PROPERTY, "complete"));
    await expect(first).resolves.toMatchObject({ state: "complete" });
  });

});
