import { isSiteIndexError, type SiteIndexError } from "@siteindex/shared";
import { API_INVOKE_METHODS, IPC_PREFIX, type ApiInvokeMethod, ipcChannel } from "../shared/ipc-contract.js";

const IPC_ERROR_PREFIX = "__SITEINDEX_IPC_ERROR__:";

export interface NotImplementedError {
  code: "NOT_IMPLEMENTED";
  message: string;
  detail: string;
}

export type IpcError = SiteIndexError | NotImplementedError;
export type IpcHandler = (...args: unknown[]) => unknown | Promise<unknown>;
export type IpcHandlerImplementations = Partial<Record<ApiInvokeMethod, IpcHandler>>;

function createNotImplementedError(method: string): Error & NotImplementedError {
  const error = new Error("该功能尚未实现");
  Object.assign(error, {
    code: "NOT_IMPLEMENTED" as const,
    detail: `接口 ${method} 将在后续里程碑接入。`,
  });
  return error as Error & NotImplementedError;
}

export function createHandlerRegistry(
  implementations: IpcHandlerImplementations = {},
): ReadonlyMap<string, IpcHandler> {
  return new Map(
    API_INVOKE_METHODS.map((method) => [
      ipcChannel(method),
      implementations[method] ??
        (() => {
          throw createNotImplementedError(method);
        }),
    ]),
  );
}

function isNotImplementedError(value: unknown): value is NotImplementedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "NOT_IMPLEMENTED" &&
    "message" in value &&
    typeof value.message === "string" &&
    "detail" in value &&
    typeof value.detail === "string"
  );
}

function asSiteIndexError(value: unknown): IpcError {
  if (isNotImplementedError(value)) return value;
  if (isSiteIndexError(value)) return value;
  return {
    code: "UNKNOWN",
    message: "桌面操作失败",
    detail: value instanceof Error ? value.message : String(value),
  };
}

/** Electron invoke 错误只传 message；用受控前缀让 preload 还原错误码。 */
export function serializeIpcError(value: unknown): Error {
  const error = asSiteIndexError(value);
  const payload = {
    code: error.code,
    message: error.message,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
  return new Error(`${IPC_ERROR_PREFIX}${JSON.stringify(payload)}`);
}

export function getIpcHandlerPaths(registry: ReadonlyMap<string, IpcHandler>): string[] {
  return [...registry.keys()].map((channel) => channel.slice(IPC_PREFIX.length)).sort();
}
