import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import {
  PROJECT_CONFIG_ITEMS, editProjectConfigItem, projectConfigItem,
  verifyProjectConfigFile, verifyProjectConfigIpc,
} from "../scripts/acceptance/project-config-items.mjs";

function fakePage(item, config = {}) {
  const actions = [];
  const control = {
    click: vi.fn(async () => { actions.push("click"); }),
    fill: vi.fn(async (value) => { actions.push(["fill", value]); }),
    selectOption: vi.fn(async (value) => { actions.push(["select", value]); }),
    inputValue: vi.fn(async () => JSON.stringify({ crawl: { user_agent: "old" } })),
    getByRole: vi.fn(() => control),
  };
  return {
    actions, control,
    page: {
      getByRole: vi.fn(() => control),
      evaluate: vi.fn(async () => ({ config: item.kind === "json"
        ? { crawl: { user_agent: item.expected } } : config })),
    },
  };
}

describe("v0.8.5 project config matrix rows 1–20", () => {
  it("retains every legacy row ID, field path, and synthetic value", () => {
    assert.deepEqual(PROJECT_CONFIG_ITEMS.map((item) => item.id), Array.from({ length: 20 }, (_, index) => index + 1));
    assert.equal(projectConfigItem(1).path, "crawl.user_agent");
    assert.deepEqual(projectConfigItem(8).expected, ["US", "CA"]);
    assert.equal(projectConfigItem(17).expected, "removed");
    assert.deepEqual(projectConfigItem(20).expected, ["https://edited.example.test/sitemap.xml"]);
    assert.throws(() => projectConfigItem(21), /Unknown project config matrix row/u);
  });

  it("edits JSON, role-named select, and array fields through the UI before saving", async () => {
    for (const id of [1, 4, 8, 13, 20]) {
      const item = projectConfigItem(id);
      const config = id === 4 ? { platform: item.expected }
        : id === 8 ? { markets: item.expected }
          : id === 13 ? { brand: { usp: item.expected } }
            : id === 20 ? { sitemaps: item.expected } : {};
      const { page, control, actions } = fakePage(item, config);
      await editProjectConfigItem(page, item, "synthetic-project");
      assert.equal(page.getByRole.mock.calls.at(-1)[1].name, "保存配置");
      assert.equal(actions.at(-1), "click");
      if (id === 1) assert.equal(JSON.parse(control.fill.mock.calls[0][0]).crawl.user_agent, item.expected);
      if (id === 4) assert.deepEqual(actions.find((action) => Array.isArray(action)), ["select", "other"]);
      if (id === 8) assert.deepEqual(actions.find((action) => Array.isArray(action)), ["fill", "US, CA"]);
      if (id === 13) assert.deepEqual(actions.find((action) => Array.isArray(action)), ["fill", "Clear records\nQuick setup"]);
      if (id === 20) assert.deepEqual(actions.find((action) => Array.isArray(action)),
        ["fill", "https://edited.example.test/sitemap.xml"]);
    }
  });

  it("compares both persisted file and fresh IPC values and rejects a missing save", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-project-config-item-"));
    const siteFile = path.join(directory, "site.json");
    const item = projectConfigItem(9);
    try {
      await writeFile(siteFile, JSON.stringify({ brand: { name: item.expected } }));
      assert.deepEqual(await verifyProjectConfigFile(item, siteFile),
        { id: 9, phase: "file-readback", status: "passed" });
      const { page } = fakePage(item, { brand: { name: item.expected } });
      assert.deepEqual(await verifyProjectConfigIpc(item, page, "synthetic-project"),
        { id: 9, phase: "ipc-readback", status: "passed" });
      await writeFile(siteFile, JSON.stringify({ brand: { name: "old" } }));
      await assert.rejects(() => verifyProjectConfigFile(item, siteFile), /not persisted/u);
      const stalePage = fakePage(item, { brand: { name: "old" } }).page;
      await assert.rejects(() => verifyProjectConfigIpc(item, stalePage, "synthetic-project"), /not persisted/u);
      assert.equal(JSON.parse(await readFile(siteFile, "utf8")).brand.name, "old");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
