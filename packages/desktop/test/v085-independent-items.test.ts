import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import {
  INDEPENDENT_ITEMS, editIndependentItem, independentItem,
  verifyIndependentFile, verifyIndependentIpc,
} from "../scripts/acceptance/independent-items.mjs";

const todoKey = "synthetic-dedupe-key";
const finding = { finding: { rule_id: "seo.issue.title_missing", title: "Synthetic title issue", dedupe_key: todoKey },
  state: { status: "in_progress", note: "Synthetic review note." } };

function fakePage(item) {
  const calls = [];
  const control = {
    click: vi.fn(async () => calls.push("click")),
    fill: vi.fn(async (value) => calls.push(["fill", value])),
  };
  const response = item.kind === "runner"
    ? { is_this_device: true, runner: { device_id: "synthetic-device" }, this_device: { device_id: "synthetic-device" } }
    : item.kind === "readme" ? { user_blocks: { [item.block]: item.expected } } : { items: [finding] };
  const page = { getByRole: vi.fn(() => control), evaluate: vi.fn(async () => response) };
  return { page, control, calls };
}

describe("v0.8.5 independent matrix rows 61–66", () => {
  it("preserves runner, README and todo IDs with synthetic values", () => {
    assert.deepEqual(INDEPENDENT_ITEMS.map((item) => item.id), [61, 62, 63, 64, 65, 66]);
    assert.equal(independentItem(61).kind, "runner");
    assert.equal(independentItem(64).missingTitleCase, true);
    assert.equal(independentItem(65).expected, "in_progress");
    assert.equal(independentItem(66).expected, "Synthetic review note.");
  });

  it("edits one row through role locators and waits for IPC state", async () => {
    for (const id of [61, 62, 64, 65, 66]) {
      const item = independentItem(id);
      const { page, control } = fakePage(item);
      const result = await editIndependentItem(page, item, "synthetic-project");
      assert(control.click.mock.calls.length > 0);
      if (id === 64) assert(control.fill.mock.calls.some(([value]) => value === item.expected));
      if (id === 65 || id === 66) {
        assert.equal(result.todoKey, todoKey);
        assert(page.getByRole.mock.calls.some(([role]) => role === "row"));
      }
    }
  });

  it("reads runner, README and todo files independently from a fresh IPC call", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-independent-item-"));
    try {
      const runner = independentItem(61);
      const runnerFile = path.join(directory, "runner.json");
      await writeFile(runnerFile, JSON.stringify({ device_id: "synthetic-device" }));
      const evidence = await verifyIndependentFile(runner, runnerFile);
      assert.equal(evidence.runnerDeviceId, "synthetic-device");
      await verifyIndependentIpc(runner, fakePage(runner).page, "synthetic-project", undefined, evidence.runnerDeviceId);

      const readme = independentItem(64);
      const readmeFile = path.join(directory, "README.md");
      await writeFile(readmeFile, `# Synthetic\n## 工作规则与偏好\n${readme.expected}\n`);
      await verifyIndependentFile(readme, readmeFile);
      await verifyIndependentIpc(readme, fakePage(readme).page, "synthetic-project");
      await writeFile(readmeFile, "# Synthetic\n");
      await assert.rejects(() => verifyIndependentFile(readme, readmeFile), /not persisted/u);

      const todo = independentItem(65);
      const todoFile = path.join(directory, "manual-state.jsonl");
      await writeFile(todoFile, `${JSON.stringify({ dedupe_key: todoKey, status: todo.expected })}\n`);
      await verifyIndependentFile(todo, todoFile, todoKey);
      await verifyIndependentIpc(todo, fakePage(todo).page, "synthetic-project", todoKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
