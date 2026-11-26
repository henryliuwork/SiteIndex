import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import {
  APP_SETTINGS_ITEMS, SCHEDULE_DAILY, SCHEDULE_JOBS, SCHEDULE_SYSTEM_EXPECTED,
  appSettingsItem, credentialStateEvidence, editAppSettingsItem,
  verifyAppSettingsFile, verifyAppSettingsIpc, verifyScheduleFile, verifySystemSetting,
} from "../scripts/acceptance/app-settings-items.mjs";

const values = {
  projects_root: "C:/synthetic-projects", device_name: "Synthetic desktop",
  cache_dir: "C:/synthetic-cache", browser: { executable_path: "C:/synthetic-browser.exe" },
  notify: { dingtalk_webhook: "https://example.test/synthetic-webhook" },
  skillDirectory: "C:/synthetic-skills", extraProject: "C:/synthetic-extra",
  hiddenProject: "C:/synthetic-hidden", conflict_patterns: ["synthetic-conflict-pattern"],
};

describe("v0.8.5 app settings matrix rows 67–83", () => {
  it("preserves every row ID and expected values", () => {
    assert.deepEqual(APP_SETTINGS_ITEMS.map((item) => item.id), Array.from({ length: 17 }, (_, index) => index + 67));
    assert.equal(appSettingsItem(72, values).expected, "custom");
    assert.equal(appSettingsItem(73, values).expected, values.browser.executable_path);
    assert.equal(appSettingsItem(77, values).expected, values.notify.dingtalk_webhook);
    assert.deepEqual(appSettingsItem(81, values).expected, values.conflict_patterns);
    assert.deepEqual(SCHEDULE_DAILY, { enabled: true, days: [2, 4], time: "17:44" });
  });

  it("edits a named textbox, waits for IPC, and verifies file/IPC readback", async () => {
    const item = appSettingsItem(68, values);
    const control = { fill: vi.fn(async () => {}), press: vi.fn(async () => {}) };
    const page = { getByRole: vi.fn(() => control), evaluate: vi.fn(async () => ({ device_name: item.expected })) };
    await editAppSettingsItem(page, item, values);
    assert.deepEqual(control.fill.mock.calls, [[item.expected]]);
    await verifyAppSettingsIpc(item, page);
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-app-setting-"));
    try {
      const settingsFile = path.join(directory, "settings.json");
      await writeFile(settingsFile, JSON.stringify({ device_name: item.expected }));
      await verifyAppSettingsFile(item, settingsFile);
      await writeFile(settingsFile, JSON.stringify({ device_name: "old" }));
      await assert.rejects(() => verifyAppSettingsFile(item, settingsFile), /not persisted/u);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("returns credential metadata only and never reads encrypted file contents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-credential-state-"));
    try {
      const vaultFile = path.join(directory, "vault.enc");
      await writeFile(vaultFile, "synthetic-encrypted-placeholder");
      const page = { evaluate: vi.fn(async () => ({ state: "configured" })) };
      assert.deepEqual(await credentialStateEvidence(page, "https://example.test", vaultFile), {
        state: "configured", safeStorageAvailable: true, encryptedFileExists: true,
      });
      assert.equal(JSON.stringify(await credentialStateEvidence(page, "https://example.test", vaultFile))
        .includes("placeholder"), false);
      await rm(vaultFile);
      assert.equal((await credentialStateEvidence(page, "https://example.test", vaultFile)).encryptedFileExists, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("requires all five real schedule registrations and preserves daily file value", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-schedule-setting-"));
    try {
      const siteFile = path.join(directory, "site.json");
      await writeFile(siteFile, JSON.stringify({ schedule: { daily: SCHEDULE_DAILY } }));
      await verifyScheduleFile(siteFile);
      const projectPath = "C:/synthetic-project";
      const executable = "C:/synthetic-app/SiteIndex.exe";
      const tasks = SCHEDULE_JOBS.map((job) => {
        const expected = SCHEDULE_SYSTEM_EXPECTED[job as keyof typeof SCHEDULE_SYSTEM_EXPECTED];
        return { job, registered: true, xmlReadable: true,
          command: executable, workingDirectory: projectPath,
          arguments: `--run-job "${projectPath}" ${job}`,
          time: expected.time,
          weekdays: "weekdays" in expected ? expected.weekdays : [],
          monthDay: job === "monthly" ? "1" : undefined,
          triggerCount: 1, actionCount: 1, enabled: true };
      });
      const item = appSettingsItem(83, values);
      verifySystemSetting(item, { tasks, projectPath, executable });
      await assert.rejects(async () => verifySystemSetting(item, { tasks: tasks.slice(1), projectPath, executable }),
        /Five Windows schedule tasks/u);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
