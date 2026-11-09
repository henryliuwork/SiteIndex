import { describe, expect, it, vi } from "vitest";
import { createWindowApi } from "./window-api.js";

describe("Desktop window bridge", () => {
  it("sends title bar overlay color updates on the private Desktop channel", () => {
    const send = vi.fn();
    const api = createWindowApi(send);

    api.setTitleBarOverlayColor("#bcbdbd");

    expect(send).toHaveBeenCalledWith("si:window.setTitleBarOverlayColor", "#bcbdbd");
  });
});
