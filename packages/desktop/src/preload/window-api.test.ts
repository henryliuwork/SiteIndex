import { describe, expect, it, vi } from "vitest";
import { createWindowApi } from "./window-api.js";

describe("Desktop window bridge", () => {
  it("sends title bar overlay color updates on the private Desktop channel", () => {
    const send = vi.fn();
    const api = createWindowApi({ send, invoke: vi.fn() });

    api.setTitleBarOverlayColor("#bcbdbd");

    expect(send).toHaveBeenCalledWith("si:window.setTitleBarOverlayColor", "#bcbdbd");
  });

  it("exposes only private credential operations and never resolves credential values", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel.endsWith(".status")) return { state: "configured" };
      return undefined;
    });
    const api = createWindowApi({ send: vi.fn(), invoke });

    await expect(api.wordpressCredentials.status("https://example.test")).resolves.toEqual({ state: "configured" });
    await api.wordpressCredentials.save({
      siteUrl: "https://example.test",
      username: "fictional-user",
      applicationPassword: "not-a-real-password",
    });
    await api.wordpressCredentials.clear("https://example.test");

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "si:desktop.wordpressCredentials.status",
      "si:desktop.wordpressCredentials.save",
      "si:desktop.wordpressCredentials.clear",
    ]);
    await expect(invoke.mock.results[1]?.value).resolves.toBeUndefined();
  });

  it("traces credential IPC method names only, without passing request values to the trace", async () => {
    const invoke = vi.fn(async () => ({ state: "configured" }));
    const trace = vi.fn();
    const api = createWindowApi({ send: vi.fn(), invoke }, trace);

    await api.wordpressCredentials.status("https://site-a.example.invalid");
    await api.wordpressCredentials.save({
      siteUrl: "https://site-a.example.invalid",
      username: "synthetic-user",
      applicationPassword: "synthetic-password",
    });
    await api.wordpressCredentials.clear("https://site-a.example.invalid");

    expect(trace.mock.calls).toEqual([["status"], ["save"], ["clear"]]);
    expect(JSON.stringify(trace.mock.calls)).not.toContain("synthetic-user");
    expect(JSON.stringify(trace.mock.calls)).not.toContain("synthetic-password");
    expect(JSON.stringify(trace.mock.calls)).not.toContain("example.invalid");
  });

  it("exposes boolean-only profile path diagnostics only when the hosted runner enables them", async () => {
    const invoke = vi.fn(async () => ({ userData: { withinRoot: true, noReparse: true } }));
    const normalApi = createWindowApi({ send: vi.fn(), invoke });
    expect(normalApi.getProfilePathDiagnostics).toBeUndefined();

    const acceptanceApi = createWindowApi({ send: vi.fn(), invoke }, undefined, true);
    await expect(acceptanceApi.getProfilePathDiagnostics?.()).resolves.toEqual({
      userData: { withinRoot: true, noReparse: true },
    });
    expect(invoke).toHaveBeenCalledWith("si:desktop.profilePathDiagnostics");
  });
});
