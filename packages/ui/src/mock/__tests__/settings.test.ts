import type { AppSettings } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { createSettingsMock } from "../settings";

describe("settings mock nested patches", () => {
  it("preserves untouched browser and notification fields", async () => {
    const api = createSettingsMock();
    const before = await api.get();
    try {
      const updated = await api.set({
        browser: { executable_path: "C:/Fixture/browser.exe" } as AppSettings["browser"],
        notify: { on_failure: !before.notify.on_failure } as AppSettings["notify"],
      });
      expect(updated.browser).toEqual({ ...before.browser, executable_path: "C:/Fixture/browser.exe" });
      expect(updated.notify).toEqual({ ...before.notify, on_failure: !before.notify.on_failure });
      expect(await api.get()).toEqual(updated);
    } finally {
      await api.set({ browser: before.browser, notify: before.notify });
    }
  });
});
