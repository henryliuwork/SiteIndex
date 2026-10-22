import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "./settings-store.js";

describe("settings store", () => {
  let settingsDirectory: string;

  beforeEach(async () => {
    settingsDirectory = await mkdtemp(join(tmpdir(), "siteindex-settings-"));
  });

  afterEach(async () => {
    await rm(settingsDirectory, { recursive: true, force: true });
  });

  it("creates a stable device identity and default settings on first read", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");

    const first = await store.get();
    const second = await store.get();

    expect(first.device_id).toBeTruthy();
    expect(second.device_id).toBe(first.device_id);
    expect(first.device_name).toBe("DESKTOP-01");
    expect(first.projects_root).toBe("");
    expect(first.cache_dir).toBe(join(settingsDirectory, "cache"));
    expect(await store.exists()).toBe(true);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(first);
  });

  it("merges partial settings and persists nested settings", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    const initial = await store.get();

    const updated = await store.set({
      device_name: "运营电脑",
      projects_root: "C:\\Sites",
      notify: { ...initial.notify, on_success: true },
    });

    expect(updated.device_id).toBe(initial.device_id);
    expect(updated.device_name).toBe("运营电脑");
    expect(updated.projects_root).toBe("C:\\Sites");
    expect(updated.notify).toEqual({ ...initial.notify, on_success: true });
  });

  it("recovers a malformed settings file with safe defaults", async () => {
    const filePath = join(settingsDirectory, "settings.json");
    await writeFile(filePath, "{ invalid json", "utf8");
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");

    const settings = await store.get();

    expect(settings.device_name).toBe("DESKTOP-01");
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(settings);
  });

  it("rejects malformed settings updates", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");

    await expect(store.set({ browser: { channel: "invalid", executable_path: null } as never })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});
