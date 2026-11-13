import type {
  GscAuthorizationStatus,
  GscPropertyListData,
  GscSyncInput,
  GscSyncMode,
  GscSyncResult,
  ProjectId,
  ScenarioQueryResult,
  SiteIndexError,
} from "@siteindex/shared";
import { GscOAuthError, type GscOAuthCredential } from "../gsc-oauth.js";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

const GSC_SOURCE = { kind: "google_search_console", label: "Google Search Console" };

function errorCode(error: unknown): string | null {
  return error instanceof GscOAuthError ? error.code : null;
}

function statusForError(error: unknown): GscAuthorizationStatus {
  switch (errorCode(error)) {
    case "CONFIGURATION_MISSING":
      return { state: "not_configured", reason: "client_id_missing" };
    case "AUTHORIZATION_REQUIRED":
      return { state: "reauthorization_required", reason: "refresh_token_rejected" };
    case "ENCRYPTION_UNAVAILABLE":
      return { state: "unavailable", reason: "encryption_unavailable" };
    case "STORAGE_UNAVAILABLE":
      return { state: "unavailable", reason: "credentials_unreadable" };
    case "NOT_CONFIGURED":
      return { state: "disconnected" };
    default:
      return { state: "unavailable" };
  }
}

function safeOAuthError(error: unknown): SiteIndexError {
  switch (errorCode(error)) {
    case "CONFIGURATION_MISSING":
      return { code: "CONFIG_INVALID", message: "Google Search Console 尚未配置 OAuth 客户端 ID。" };
    case "NOT_CONFIGURED":
      return { code: "CONFIG_INVALID", message: "请先连接 Google Search Console，再读取或选择属性。" };
    case "AUTHORIZATION_REQUIRED":
      return { code: "UNKNOWN", message: "Google Search Console 授权已失效，请重新连接。" };
    case "ENCRYPTION_UNAVAILABLE":
      return { code: "UNKNOWN", message: "本机安全存储暂不可用，Google Search Console 凭据未读取或保存。" };
    case "STORAGE_UNAVAILABLE":
      return { code: "UNKNOWN", message: "无法安全读取或保存 Google Search Console 凭据。" };
    case "NETWORK_ERROR":
      return { code: "UNKNOWN", message: "暂时无法连接 Google Search Console，请稍后重试。" };
    case "PROPERTY_LIST_FAILED":
      return { code: "UNKNOWN", message: "无法安全读取 Google Search Console 属性列表。" };
    default:
      return { code: "UNKNOWN", message: "Google Search Console 操作未完成。" };
  }
}

function safeFailureResult(error: unknown): never {
  throw safeOAuthError(error);
}

function selectedProperty(config: Awaited<ReturnType<IpcContext["core"]["projects"]["get"]>>["config"]): string | null {
  const value = config.integrations?.gsc?.property_site_url;
  return typeof value === "string" ? value : null;
}

export function createGscHandlers(context: IpcContext): IpcHandlerImplementations {
  let reauthorizationRequired = false;
  const syncsInProgress = new Set<string>();

  function syncFailure(
    mode: GscSyncMode,
    property: string | null,
    code: string,
    message: string,
  ): GscSyncResult {
    return {
      state: "blocked",
      mode,
      records_received: 0,
      records_written: 0,
      history_effect: "preserved",
      metadata: {
        data_source: "google_search_console",
        property_site_url: property,
        requested_at: new Date().toISOString(),
        collected_at: null,
        data_through: null,
        requested_range: null,
        missing_ranges: [],
        missing_fields: [],
        quality: "partial",
        anomalies: [{ code, severity: "warning", message }],
      },
      error: { code, message },
    };
  }

  async function sync(id: ProjectId, value: unknown): Promise<GscSyncResult> {
    if (!value || typeof value !== "object" || !("mode" in value) ||
      (value.mode !== "initial_90_days" && value.mode !== "incremental")) {
      throw {
        code: "CONFIG_INVALID",
        message: "Search Console 同步模式无效。",
      } satisfies SiteIndexError;
    }
    const input: GscSyncInput = { mode: value.mode };
    const projectPath = context.projects.resolveProject(id);
    const project = await context.core.projects.get(id);
    const property = selectedProperty(project.config);
    if (syncsInProgress.has(id)) {
      return syncFailure(input.mode, property, "GSC_SYNC_IN_PROGRESS", "该项目的 Search Console 同步正在进行，请稍后再试。");
    }
    if (!property) {
      return context.syncGscProjectSearchAnalytics(projectPath, input, { property: null, accessToken: "" });
    }
    if (!context.gscClientIdConfigured) {
      return syncFailure(input.mode, property, "GSC_NOT_CONFIGURED", "Google Search Console 尚未配置 OAuth 客户端 ID。");
    }

    syncsInProgress.add(id);
    try {
      let credential: GscOAuthCredential | null;
      try {
        credential = await context.gscOAuth.getCredentials();
      } catch (error) {
        if (errorCode(error) === "AUTHORIZATION_REQUIRED") {
          reauthorizationRequired = true;
          return syncFailure(input.mode, property, "GSC_REAUTHORIZATION_REQUIRED", "Google Search Console 授权已失效，请重新连接。");
        }
        if (errorCode(error) === "NOT_CONFIGURED") {
          return await context.syncGscProjectSearchAnalytics(projectPath, input, { property, accessToken: "" });
        }
        return syncFailure(input.mode, property, "GSC_CREDENTIALS_UNAVAILABLE", safeOAuthError(error).message);
      }
      reauthorizationRequired = false;
      return await context.syncGscProjectSearchAnalytics(projectPath, input, {
        property,
        accessToken: credential?.accessToken ?? "",
      });
    } finally {
      syncsInProgress.delete(id);
    }
  }

  async function getStatus(): Promise<GscAuthorizationStatus> {
    if (!context.gscClientIdConfigured) return { state: "not_configured", reason: "client_id_missing" };
    if (reauthorizationRequired) return { state: "reauthorization_required", reason: "refresh_token_rejected" };
    try {
      const credential = await context.gscOAuth.getCredentials();
      return credential ? { state: "connected" } : { state: "disconnected" };
    } catch (error) {
      return statusForError(error);
    }
  }

  async function listProviderProperties() {
    try {
      return await context.gscOAuth.listProperties();
    } catch (error) {
      if (errorCode(error) === "AUTHORIZATION_REQUIRED") reauthorizationRequired = true;
      safeFailureResult(error);
    }
  }

  function requireClientId(): void {
    if (!context.gscClientIdConfigured) {
      throw {
        code: "CONFIG_INVALID",
        message: "Google Search Console 尚未配置 OAuth 客户端 ID。",
      } satisfies SiteIndexError;
    }
  }

  return {
    "gsc.status": getStatus,
    "gsc.connect": async () => {
      if (!context.gscClientIdConfigured) return { state: "not_configured", reason: "client_id_missing" };
      try {
        await context.gscOAuth.authorize();
        reauthorizationRequired = false;
      } catch (error) {
        if (errorCode(error) === "CANCELLED" || errorCode(error) === "AUTHORIZATION_IN_PROGRESS") {
          return getStatus();
        }
        return statusForError(error);
      }
      return getStatus();
    },
    "gsc.disconnect": async () => {
      try {
        await context.gscOAuth.clear();
        reauthorizationRequired = false;
      } catch (error) {
        return statusForError(error);
      }
      return getStatus();
    },
    "gsc.sync": (...args) => context.withProject(args[0], (id) => sync(id, args[1])),
    "gsc.listProperties": (...args) =>
      context.withProject(args[0], async (id) => {
        requireClientId();
        const properties = await listProviderProperties();
        const project = await context.core.projects.get(id);
        const storedSelection = selectedProperty(project.config);
        const selected = properties.find((property) => property.siteUrl === storedSelection);
        const selectionMissing = storedSelection !== null && selected === undefined;
        const result: ScenarioQueryResult<GscPropertyListData> = {
          data: {
            properties: properties.map((property) => ({
              site_url: property.siteUrl,
              permission_level: property.permissionLevel,
            })),
            selected_site_url: selected?.siteUrl ?? null,
          },
          metadata: {
            sources: [GSC_SOURCE],
            collected_at: new Date().toISOString(),
            missing_fields: [],
            quality: selectionMissing ? "partial" : "complete",
            anomalies: selectionMissing
              ? [
                  {
                    code: "GSC_SELECTED_PROPERTY_UNAVAILABLE",
                    severity: "warning",
                    message: "项目当前选择的 Search Console 属性不在已授权账号的可访问列表中。",
                    field: "selected_site_url",
                  },
                ]
              : [],
          },
        };
        reauthorizationRequired = false;
        return result;
      }),
    "gsc.selectProperty": (...args) =>
      context.withProject(args[0], async (id) => {
        const requestedValue = args[1];
        if (
          requestedValue !== null &&
          (typeof requestedValue !== "string" || !requestedValue.trim() || requestedValue.length > 2048)
        ) {
          throw {
            code: "CONFIG_INVALID",
            message: "Search Console 属性选择无效。",
          } satisfies SiteIndexError;
        }
        const siteUrl = typeof requestedValue === "string" ? requestedValue.trim() : null;
        if (siteUrl !== null) {
          requireClientId();
          const properties = await listProviderProperties();
          if (!properties.some((property) => property.siteUrl === siteUrl)) {
            throw {
              code: "CONFIG_INVALID",
              message: "所选属性不在当前已授权账号的属性列表中。",
            } satisfies SiteIndexError;
          }
          reauthorizationRequired = false;
        }

        const project = await context.core.projects.get(id);
        const currentSelection = selectedProperty(project.config);
        if (currentSelection === siteUrl) return { site_url: siteUrl };

        const integrations = { ...(project.config.integrations ?? {}) };
        const gsc = { ...(integrations.gsc ?? {}) };
        if (siteUrl === null) delete gsc.property_site_url;
        else gsc.property_site_url = siteUrl;
        if (Object.keys(gsc).length > 0) integrations.gsc = gsc;
        else delete integrations.gsc;

        const nextIntegrations = Object.keys(integrations).length > 0 ? integrations : undefined;
        await context.core.projects.updateConfig(id, { integrations: nextIntegrations });
        return { site_url: siteUrl };
      }),
  };
}
