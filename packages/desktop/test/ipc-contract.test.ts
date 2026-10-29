import { describe, expect, it } from "vitest";
import type { SiteIndexApi } from "@siteindex/shared";
import { createHandlerRegistry, getIpcHandlerPaths, serializeIpcError } from "../src/main/ipc-registry.js";
import { createApiBridge } from "../src/preload/api.js";
import { API_EVENT_METHODS, API_INVOKE_METHODS } from "@siteindex/shared";

function getApiMethodPaths(api: SiteIndexApi): string[] {
  return Object.entries(api)
    .flatMap(([namespace, methods]) => Object.keys(methods).map((method) => `${namespace}.${method}`))
    .sort();
}

describe("SiteIndex IPC contract", () => {
  it("exposes every SiteIndexApi method and marks only event methods as listeners", () => {
    const api = createApiBridge({
      invoke: async () => undefined,
      listen: () => () => undefined,
    });
    const apiMethods = getApiMethodPaths(api);
    const eventMethods = [...API_EVENT_METHODS].sort();

    expect(apiMethods.filter((method) => !eventMethods.includes(method))).toEqual([...API_INVOKE_METHODS].sort());
    expect(apiMethods.filter((method) => eventMethods.includes(method))).toEqual(eventMethods);
  });

  it("registers exactly one IPC handler for each invoke method", () => {
    expect(getIpcHandlerPaths(createHandlerRegistry())).toEqual([...API_INVOKE_METHODS].sort());
  });

  it("returns missing implementations as structured NOT_IMPLEMENTED errors", async () => {
    const handlers = createHandlerRegistry();
    const handler = handlers.get("si:overview.get");
    if (!handler) throw new Error("overview.get handler is missing");

    await expect(Promise.resolve().then(() => handler("demo-project"))).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "该功能尚未实现",
    });
  });

  it("restores SiteIndex errors after Electron IPC serializes them", async () => {
    const ipcError = serializeIpcError({
      code: "NOT_IMPLEMENTED",
      message: "该功能尚未实现",
      detail: "overview.get 尚未接入 core。",
    });
    const api = createApiBridge({
      invoke: async () => Promise.reject(ipcError),
      listen: () => () => undefined,
    });

    await expect(api.overview.get("demo-project")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "该功能尚未实现",
      detail: "overview.get 尚未接入 core。",
    });
  });
});
