import { describe, expect, it } from "vitest";
import { backgroundPolicy } from "./background-policy.js";

describe("background policy", () => {
  it("uses tray on close by default without enabling login autostart", () => {
    expect(backgroundPolicy({}, "system", "win32", true)).toEqual({
      keepTray: true,
      hideOnClose: true,
      openAtLogin: false,
      backgroundAtLogin: false,
    });
  });

  it("exits on close when tray behavior is disabled", () => {
    expect(backgroundPolicy({ close_to_tray: false }, "system", "darwin", true)).toEqual({
      keepTray: false,
      hideOnClose: false,
      openAtLogin: false,
      backgroundAtLogin: false,
    });
  });

  it("keeps the resident fallback available at login on Windows", () => {
    expect(backgroundPolicy({ close_to_tray: false }, "resident", "win32", true)).toEqual({
      keepTray: true,
      hideOnClose: false,
      openAtLogin: true,
      backgroundAtLogin: true,
    });
  });

  it("honors user login preference on macOS", () => {
    expect(backgroundPolicy({ close_to_tray: false, launch_at_login: true }, "system", "darwin", false)).toEqual({
      keepTray: false,
      hideOnClose: false,
      openAtLogin: true,
      backgroundAtLogin: false,
    });
  });
});
