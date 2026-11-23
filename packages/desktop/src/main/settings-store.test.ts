import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppSettingsSnapshot } from "@siteindex/shared";
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
    expect(first.hidden_projects).toEqual([]);
    expect(first.close_to_tray).toBe(true);
    expect(first.launch_at_login).toBe(false);
    expect(first.cache_dir).toBe(join(settingsDirectory, "cache"));
    expect(await store.exists()).toBe(true);
    const persisted = { ...first };
    delete persisted.revision;
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(persisted);
  });

  it("merges partial settings and persists nested settings", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    const initial = await store.get();

    const updated = await store.set({
      device_name: "运营电脑",
      projects_root: "C:\\Sites",
      close_to_tray: false,
      launch_at_login: true,
      notify: { ...initial.notify, on_success: true },
    });

    expect(updated.device_id).toBe(initial.device_id);
    expect(updated.device_name).toBe("运营电脑");
    expect(updated.projects_root).toBe("C:\\Sites");
    expect(updated.close_to_tray).toBe(false);
    expect(updated.launch_at_login).toBe(true);
    expect(updated.notify).toEqual({ ...initial.notify, on_success: true });
  });

  it("serializes concurrent updates and leaves valid settings on disk", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    await store.get();

    const updates = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.set({ device_name: `DESKTOP-${index + 1}`, projects_root: `C:\\Sites\\${index + 1}` }),
      ),
    );
    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as Record<string, unknown>;

    expect(updates).toHaveLength(10);
    expect(updates.map(({ device_name }) => device_name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `DESKTOP-${index + 1}`),
    );
    expect(persisted.device_name).toBe("DESKTOP-10");
    expect(persisted.projects_root).toBe("C:\\Sites\\10");
    expect(persisted.device_id).toBeTruthy();
    expect(await readdir(settingsDirectory)).toEqual(["settings.json"]);
  });

  it("does not rewrite already-normalized settings on read", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    await store.get();
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(store.filePath, oldTime, oldTime);

    await store.get();

    const { mtimeMs } = await stat(store.filePath);
    expect(mtimeMs).toBe(oldTime.getTime());
  });

  it("keeps future user fields when reading and saving known settings", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    const initial = await store.get();
    const stored = { ...initial };
    delete stored.revision;
    const original = `${JSON.stringify({
      ...stored,
      future_user_field: "保留此值",
      browser: { ...initial.browser, future_browser_field: "browser-choice" },
      notify: { ...initial.notify, future_notify_field: "notification-choice" },
    }, null, 4)}\n`;
    await writeFile(store.filePath, original, "utf8");

    await store.get();
    expect(await readFile(store.filePath, "utf8")).toBe(original);

    await store.set({ device_name: "虚构电脑" });
    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as Record<string, unknown>;
    expect(persisted.future_user_field).toBe("保留此值");
    expect(persisted.browser).toMatchObject({ future_browser_field: "browser-choice" });
    expect(persisted.notify).toMatchObject({ future_notify_field: "notification-choice" });
    expect((await createSettingsStore(settingsDirectory, "OTHER-DEVICE").get()).device_name).toBe("虚构电脑");
  });

  it("leaves a valid settings file byte-identical when saving no changes", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    const settings = await store.get();
    const stored = { ...settings };
    delete stored.revision;
    const original = `${JSON.stringify(stored, null, 4)}\n`;
    await writeFile(store.filePath, original, "utf8");

    await store.set({});
    expect(await readFile(store.filePath, "utf8")).toBe(original);
    await store.set({ device_name: settings.device_name });
    expect(await readFile(store.filePath, "utf8")).toBe(original);
    const latest = await store.get();
    await store.set({ notify: { on_success: true } }, { revision: latest.revision, dirty_paths: [] });
    expect(await readFile(store.filePath, "utf8")).toBe(original);
  });

  it("recovers a malformed settings file with safe defaults", async () => {
    const filePath = join(settingsDirectory, "settings.json");
    await writeFile(filePath, "{ invalid json", "utf8");
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");

    const settings = await store.get();

    expect(settings.device_name).toBe("DESKTOP-01");
    const persisted = { ...settings };
    delete persisted.revision;
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(persisted);
  });

  it("rejects malformed settings updates", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");

    await expect(store.set({ browser: { channel: "invalid", executable_path: null } as never })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(store.set({ close_to_tray: "yes" as never })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(store.set({ launch_at_login: 1 as never })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("persists hidden project paths and validates their shape", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    await store.set({ hidden_projects: ["C:\\Projects\\fictional"] });
    expect((await store.get()).hidden_projects).toEqual(["C:\\Projects\\fictional"]);
    await expect(store.set({ hidden_projects: [42] as never })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects a stale notification draft and preserves the newer saved field", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    const stale = await store.get() as AppSettingsSnapshot;
    await store.set({ notify: { on_success: true } }, {
      revision: stale.revision, dirty_paths: ["notify.on_success"],
    });
    await expect(store.set({ notify: { ...stale.notify, on_failure: false } }, {
      revision: stale.revision, dirty_paths: ["notify.on_failure"],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "配置已在别处更新，请刷新后重试。" });
    expect((await store.get()).notify).toMatchObject({ on_success: true, on_failure: true });
  });

  it("applies only dirty nested fields and requires explicit clear for empty values", async () => {
    const store = createSettingsStore(settingsDirectory, "DESKTOP-01");
    const initial = await store.get() as AppSettingsSnapshot;
    const changed = await store.set({ notify: { on_success: true } }, {
      revision: initial.revision, dirty_paths: ["notify.on_success"],
    });
    await store.set({ notify: { ...initial.notify, on_failure: false } }, {
      revision: changed.revision, dirty_paths: ["notify.on_failure"],
    });
    expect((await store.get()).notify).toMatchObject({ on_success: true, on_failure: false });
    const before = await readFile(store.filePath, "utf8");
    const current = await store.get() as AppSettingsSnapshot;
    await expect(store.set({ device_name: "" }, {
      revision: current.revision, dirty_paths: ["device_name"],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(store.filePath, "utf8")).toBe(before);
    await store.set({ device_name: "" }, {
      revision: current.revision, dirty_paths: ["device_name"], clear: ["device_name"],
    });
    expect((await store.get()).device_name).toBe("");
  });
});
