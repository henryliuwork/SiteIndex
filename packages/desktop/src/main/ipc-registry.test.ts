import { describe, expect, it } from "vitest";
import { API_INVOKE_METHODS, ipcChannel } from "../shared/ipc-contract.js";
import { createHandlerRegistry, getIpcHandlerPaths } from "./ipc-registry.js";

describe("IPC invoke registry contract", () => {
  it("registers every shared invoke method exactly once", () => {
    const registry = createHandlerRegistry();
    expect(registry.size).toBe(API_INVOKE_METHODS.length);
    expect(getIpcHandlerPaths(registry)).toEqual([...API_INVOKE_METHODS].sort());
  });

  it("uses an implementation when available and returns NOT_IMPLEMENTED otherwise", async () => {
    const registry = createHandlerRegistry({ "app.version": async () => "0.1.0" });
    await expect(registry.get(ipcChannel("app.version"))?.()).resolves.toBe("0.1.0");
    await expect(Promise.resolve().then(() => registry.get(ipcChannel("jobs.run"))?.())).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      detail: expect.stringContaining("jobs.run"),
    });
  });
});
