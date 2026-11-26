import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import {
  ADVANCED_CONFIG_ITEMS, advancedConfigItem, editAdvancedConfigItem,
  verifyAdvancedConfigFile, verifyAdvancedConfigIpc,
} from "../scripts/acceptance/project-config-advanced-items.mjs";

function configFor(item) {
  const config = {};
  const parts = item.path.split(".");
  const target = parts.slice(0, -1).reduce((section, part) => section[part] ??= {}, config);
  target[parts.at(-1)] = item.expected;
  return config;
}

function fakePage(item, config = configFor(item)) {
  const calls = [];
  const control = {
    click: vi.fn(async () => { calls.push(["click"]); }),
    fill: vi.fn(async (value) => { calls.push(["fill", value]); }),
    selectOption: vi.fn(async (value) => { calls.push(["select", value]); }),
    isChecked: vi.fn(async () => !item.expected),
    nth: vi.fn(() => control),
    getByRole: vi.fn(() => control),
  };
  const page = { getByRole: vi.fn(() => control), evaluate: vi.fn(async () => ({ config })) };
  return { page, control, calls };
}

describe("v0.8.5 project config matrix rows 21–45", () => {
  it("preserves the legacy row IDs, keys, and synthetic meanings", () => {
    assert.deepEqual(ADVANCED_CONFIG_ITEMS.map((item) => item.id), Array.from({ length: 25 }, (_, index) => index + 21));
    assert.deepEqual(advancedConfigItem(21).expected, { "SYN-001": { title: "Synthetic override" } });
    assert.equal(advancedConfigItem(25).path, "crawl.auto_collect_products");
    assert.equal(advancedConfigItem(32).expected[0].manual, true);
    assert.deepEqual(advancedConfigItem(42).expected, ["manual", "feed"]);
    assert.equal(advancedConfigItem(45).path, "integrations.linkflow.create_tool");
    assert.throws(() => advancedConfigItem(46), /Unknown advanced config matrix row/u);
  });

  it("uses roles for JSON, checkbox, category, range, select and array edits", async () => {
    for (const id of [21, 24, 32, 35, 42, 26]) {
      const item = advancedConfigItem(id);
      const { page, control, calls } = fakePage(item);
      await editAdvancedConfigItem(page, item, "synthetic-project");
      assert.equal(page.getByRole.mock.calls.at(-1)[1].name, "保存配置");
      assert.deepEqual(calls.at(-1), ["click"]);
      if (id === 21) assert.deepEqual(JSON.parse(control.fill.mock.calls[0][0]), item.expected);
      if (id === 24) assert.equal(control.isChecked.mock.calls.length, 1);
      if (id === 32) assert.equal(control.fill.mock.calls.length, 3);
      if (id === 35) assert.deepEqual(control.fill.mock.calls.map(([value]) => value), ["32", "62"]);
      if (id === 42) assert.deepEqual(control.selectOption.mock.calls[0], ["manual,feed"]);
      if (id === 26) assert.deepEqual(control.fill.mock.calls[0], ["/synthetic-private/*"]);
    }
  });

  it("checks saved file and fresh IPC values and catches a missing save", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-advanced-item-"));
    const siteFile = path.join(directory, "site.json");
    const item = advancedConfigItem(40);
    try {
      await writeFile(siteFile, JSON.stringify(configFor(item)));
      assert.deepEqual(await verifyAdvancedConfigFile(item, siteFile),
        { id: 40, phase: "file-readback", status: "passed" });
      assert.deepEqual(await verifyAdvancedConfigIpc(item, fakePage(item).page, "synthetic-project"),
        { id: 40, phase: "ipc-readback", status: "passed" });
      const stale = { edm: { utm: { source: "old" } } };
      await writeFile(siteFile, JSON.stringify(stale));
      await assert.rejects(() => verifyAdvancedConfigFile(item, siteFile), /not persisted/u);
      await assert.rejects(() => verifyAdvancedConfigIpc(item, fakePage(item, stale).page, "synthetic-project"),
        /not persisted/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
