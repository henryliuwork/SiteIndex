import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { appSettingsAdapter, appSettingsHandlers, appSettingsValues, startupEntries } from
  "../scripts/acceptance/app-settings-adapters.mjs";

describe("v0.8.5 application settings adapters 67–81", () => {
  it("registers complete isolated handlers and derives synthetic paths", () => {
    const root = path.resolve("C:/synthetic-runner");
    const profile = { root, layout: { projectRoot: path.join(root, "projects") } };
    const values = appSettingsValues(profile);
    assert.equal(values.projects_root, profile.layout.projectRoot);
    assert.equal(values.extraProject.startsWith(root), true);
    assert.equal(values.hiddenProject.startsWith(profile.layout.projectRoot), true);
    assert.match(values.notify.dingtalk_webhook, /\.example\.test\//u);
    const handlers = appSettingsHandlers(Array.from({ length: 15 }, (_, index) => index + 67));
    for (const id of Object.keys(handlers)) {
      for (const phase of ["baselineUi", "verifyBaselineIpc", "verifyBaselineFile",
        "candidateUi", "verifyCandidateIpc", "verifyCandidateFile"]) {
        assert.equal(typeof handlers[Number(id)][phase], "function", `row ${id} ${phase}`);
      }
    }
    assert.throws(() => appSettingsAdapter(82), /Unsupported/u);
  });

  it("reads only the installed executable's Windows startup entry", () => {
    const exe = "C:\\isolated\\SiteIndex.exe";
    const run = vi.fn(() => ({ status: 0,
      stdout: `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\n`
        + `    SiteIndex  REG_SZ  \"${exe}\" --siteindex-background\n`
        + "    Unrelated  REG_SZ  C:\\other\\app.exe\n", stderr: "" }));
    assert.deepEqual(startupEntries(exe, run).map((entry) => entry.name), ["SiteIndex"]);
    assert.deepEqual(startupEntries("C:\\other\\SiteIndex.exe", run), []);
    assert.deepEqual(run.mock.calls[0][1], ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"]);
  });

  it("rejects candidate startup that rewrites the baseline settings file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-setting-adapter-"));
    const profile = { root, layout: { projectRoot: path.join(root, "projects"),
      appDataRoot: path.join(root, "appdata"), installDir: path.join(root, "app") } };
    try {
      const file = path.join(profile.layout.appDataRoot, "SiteIndex", "settings.json");
      await mkdir(path.dirname(file), { recursive: true });
      const settings = { device_name: "Synthetic acceptance desktop" };
      await writeFile(file, `${JSON.stringify(settings)}\n`);
      const control = { fill: vi.fn(async () => {}), press: vi.fn(async () => {}), waitFor: vi.fn(async () => {}) };
      const page = { evaluate: vi.fn(async () => settings), getByRole: vi.fn(() => control) };
      const handler = appSettingsAdapter(68);
      await handler.baselineUi({ page, profile, noteIpc: vi.fn() });
      await handler.verifyBaselineIpc({ page, profile, noteIpc: vi.fn() });
      await handler.verifyBaselineFile({ profile });
      await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
      await assert.rejects(() => handler.candidateUi({ page, profile }), /bytes changed/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
