import type { AppSettings } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { createSettingsMock } from "../settings";

describe("settings mock nested patches", () => {
  it("rejects a stale revision without overwriting another session's field", async () => {
    const api = createSettingsMock();
    const before = await api.get();
    try {
      await api.set({ notify: { on_success: !before.notify.on_success } }, {
        revision: before.revision, dirty_paths: ["notify.on_success"],
      });
      await expect(api.set({ notify: { on_failure: !before.notify.on_failure } }, {
        revision: before.revision, dirty_paths: ["notify.on_failure"],
      })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "配置已在别处更新，请刷新后重试。" });
      expect((await api.get()).notify).toMatchObject({ on_success: !before.notify.on_success, on_failure: before.notify.on_failure });
    } finally {
      await api.set({ notify: before.notify });
    }
  });

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
