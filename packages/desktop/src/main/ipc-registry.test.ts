import { describe, expect, it } from "vitest";
import { API_INVOKE_METHODS } from "@siteindex/shared";
import { ipcChannel } from "../shared/ipc-contract.js";
import { createHandlerRegistry, getIpcHandlerPaths, serializeIpcError } from "./ipc-registry.js";
import { scheduleErrorDetail } from "./error-detail.js";

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

  it("passes a redacted ErrorDetail through Electron IPC serialization without a stack", () => {
    const error_detail = scheduleErrorDetail("schedule.save", Object.assign(new Error("password=CANARY_PASSWORD"), {
      code: 5, command: ["schtasks.exe", "/Create", "/TN", "SiteIndex-CANARY_TASK"],
      stderr: "Authorization: Basic CANARY_BASIC\nCookie: session=CANARY_COOKIE\nSet-Cookie: sid=CANARY_SET_COOKIE\nC:\\Users\\CANARY_USER\\task.xml",
    }));
    const serialized = serializeIpcError({ code: "UNKNOWN", message: "计划任务操作失败。", error_detail }).message;
    const payload = JSON.parse(serialized.replace(/^__SITEINDEX_IPC_ERROR__:/u, ""));
    expect(payload.error_detail).toMatchObject({ operation: "schedule.save", exitCode: 5,
      command: ["schtasks.exe", "[redacted]", "/TN", "[redacted]"] });
    expect(serialized).not.toMatch(/CANARY_PASSWORD|CANARY_BASIC|CANARY_USER|CANARY_TASK|CANARY_COOKIE|CANARY_SET_COOKIE|stack/u);
    const untrusted = serializeIpcError({ code: "UNKNOWN", message: "计划任务操作失败。",
      error_detail: { code: "OS", operation: "schedule.verify", command: ["schtasks.exe", "CANARY_TASK"],
        stderr: "password=CANARY_PASSWORD", cause: "C:\\Users\\CANARY_USER\\task.xml" } }).message;
    expect(untrusted).not.toMatch(/CANARY_PASSWORD|CANARY_USER|CANARY_TASK/u);
    const code = scheduleErrorDetail("schedule.verify", Object.assign(new Error("synthetic"),
      { code: "password=CANARY_CODE" }));
    expect(JSON.stringify(code)).not.toContain("CANARY_CODE");
  });
});
