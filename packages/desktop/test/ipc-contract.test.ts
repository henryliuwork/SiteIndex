import { describe, expect, it } from "vitest";
import type { SiteIndexApi } from "@siteindex/shared";
import { createHandlerRegistry, getIpcHandlerPaths, serializeIpcError } from "../src/main/ipc-registry.js";
import { createApiBridge } from "../src/preload/api.js";
import { API_EVENT_METHODS, API_INVOKE_METHODS, PENDING_HANDLERS } from "@siteindex/shared";

function getApiMethodPaths(api: SiteIndexApi): string[] {
  return Object.entries(api)
    .flatMap(([namespace, methods]) => Object.keys(methods).map((method) => `${namespace}.${method}`))
    .sort();
}

function expectInvokeCoverage(
  bridgeInvokeMethods: readonly string[],
  contractInvokeMethods: readonly string[],
  pendingHandlers: readonly string[],
): void {
  const contractMethods = new Set(contractInvokeMethods);
  const bridgeMethods = new Set(bridgeInvokeMethods);
  const pendingMethods = new Set(pendingHandlers);

  expect(pendingHandlers.filter((method) => !contractMethods.has(method))).toEqual([]);
  expect(bridgeInvokeMethods.filter((method) => !contractMethods.has(method))).toEqual([]);
  expect(contractInvokeMethods.filter((method) => !pendingMethods.has(method) && !bridgeMethods.has(method))).toEqual(
    [],
  );
}

describe("SiteIndex IPC contract", () => {
  it("exposes every SiteIndexApi method and marks only event methods as listeners", () => {
    const api = createApiBridge({
      invoke: async () => undefined,
      listen: () => () => undefined,
    });
    const apiMethods = getApiMethodPaths(api);
    const eventMethods = [...API_EVENT_METHODS].sort();
    const invokeMethods = apiMethods.filter((method) => !eventMethods.includes(method));

    expectInvokeCoverage(invokeMethods, API_INVOKE_METHODS, PENDING_HANDLERS);
    expect(apiMethods.filter((method) => eventMethods.includes(method))).toEqual(eventMethods);
  });

  it("allows pending invoke methods to be absent or exposed before their pending entry is cleared", () => {
    const contractMethods = ["settings.get", "example.pending"];
    const pendingMethods = ["example.pending"];

    expect(() => expectInvokeCoverage(["settings.get"], contractMethods, pendingMethods)).not.toThrow();
    expect(() =>
      expectInvokeCoverage(["settings.get", "example.pending"], contractMethods, pendingMethods),
    ).not.toThrow();
  });

  it("rejects bridge invoke methods outside the contract", () => {
    expect(() => expectInvokeCoverage(["settings.get", "extra.method"], ["settings.get"], [])).toThrow();
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
