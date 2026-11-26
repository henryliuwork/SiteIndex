import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { projectConfigAdapter, projectConfigHandlers } from "../scripts/acceptance/project-config-adapters.mjs";

async function fixture(id: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-config-adapter-"));
  const profile = { layout: { projectRoot: root } };
  const siteFile = path.join(root, `synthetic-config-${id}`, "_site-index", "site.json");
  await mkdir(path.dirname(siteFile), { recursive: true });
  const config = id === 2 ? { domain: "edited.example.test", brand: { name: "Synthetic Brand" } }
    : { integrations: { linkflow: { create_tool: "synthetic-create" } }, brand: { name: "Synthetic Brand" } };
  await writeFile(siteFile, `${JSON.stringify(config)}\n`);
  return { root, profile, siteFile, config };
}

function fakePage(config: object, afterClick?: () => Promise<void>) {
  const button = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => { await afterClick?.(); }) };
  const status = { allTextContents: vi.fn(async () => ["配置已保存。"]) };
  const page = { evaluate: vi.fn(async (fn: unknown) => String(fn).includes("projects.get") ? { config } : undefined),
    getByRole: vi.fn((role: string) => role === "status" ? status : button) };
  return { page, button };
}

describe("v0.8.5 project config row adapters 1–45", () => {
  it("maps only the two existing project config matrices", () => {
    assert.deepEqual(Object.keys(projectConfigHandlers([1, 20, 21, 45])), ["1", "20", "21", "45"]);
    assert.throws(() => projectConfigAdapter(46), /no matrix row/u);
  });

  it("requires unchanged bytes through candidate launch and no-op UI save", async () => {
    const { root, profile, siteFile, config } = await fixture(2);
    try {
      const adapter = projectConfigAdapter(2);
      await adapter.verifyBaselineFile({ profile });
      const { page, button } = fakePage(config);
      await adapter.candidateUi({ page, profile, noteIpc: () => {} });
      await adapter.verifyCandidateIpc({ page, noteIpc: () => {} });
      await adapter.verifyCandidateFile({ profile });
      assert.equal(button.click.mock.calls.length, 1);
      const original = await readFile(siteFile, "utf8");
      await writeFile(siteFile, `${original} `);
      await assert.rejects(() => adapter.candidateUi({ page, profile, noteIpc: () => {} }),
        (error: { acceptanceStatus?: string }) => error.acceptanceStatus === "assertion_failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a no-op save that rewrites the file", async () => {
    const { root, profile, siteFile, config } = await fixture(45);
    try {
      const adapter = projectConfigAdapter(45);
      await adapter.verifyBaselineFile({ profile });
      const { page } = fakePage(config, async () => writeFile(siteFile, `${JSON.stringify(config)} `));
      await assert.rejects(() => adapter.candidateUi({ page, profile, noteIpc: () => {} }),
        (error: { acceptanceStatus?: string }) => error.acceptanceStatus === "assertion_failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
