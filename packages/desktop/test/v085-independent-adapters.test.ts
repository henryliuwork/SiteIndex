import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { hasTodoHistoryEvent, independentAdapter, independentHandlers,
  withoutRulesHeading } from "../scripts/acceptance/independent-adapters.mjs";

describe("v0.8.5 independent matrix adapters 61–66", () => {
  it("maps only the six existing runner, README and todo rows", () => {
    assert.deepEqual(Object.keys(independentHandlers([61, 62, 63, 64, 65, 66])),
      ["61", "62", "63", "64", "65", "66"]);
    assert.throws(() => independentAdapter(67), /Unknown independent/u);
  });

  it("keeps the todo action in the history and models the missing rules heading", () => {
    const history = `${JSON.stringify({ dedupe_key: "synthetic-key", action: "status_changed" })}\n`;
    assert.equal(hasTodoHistoryEvent(history, "synthetic-key", 65), true);
    assert.equal(hasTodoHistoryEvent(history, "synthetic-key", 66), false);
    const readme = "# Synthetic\n## 工作规则与偏好\nOld rule\n## Next\n";
    const missing = withoutRulesHeading(readme);
    assert.equal(missing.includes("## 工作规则与偏好"), false);
    assert.equal(missing.includes("Old rule"), true);
  });

  it("rejects candidate README byte changes before checking the UI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-independent-adapter-"));
    try {
      const projectDir = path.join(root, "synthetic-independent-62");
      await mkdir(projectDir, { recursive: true });
      const readmeFile = path.join(projectDir, "README.md");
      await writeFile(readmeFile, "# Synthetic\n## 项目概况\nSynthetic project overview.\n");
      const profile = { layout: { projectRoot: root } };
      const adapter = independentAdapter(62);
      await adapter.verifyBaselineFile({ profile });
      await writeFile(readmeFile, "# Synthetic\n## 项目概况\nChanged after upgrade.\n");
      const page = { getByRole: vi.fn(), evaluate: vi.fn() };
      await assert.rejects(() => adapter.candidateUi({ page, profile, noteIpc: () => {} }),
        (error: { acceptanceStatus?: string }) => error.acceptanceStatus === "assertion_failed");
      assert.equal(page.getByRole.mock.calls.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
