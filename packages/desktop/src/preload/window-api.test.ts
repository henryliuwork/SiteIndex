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
});
