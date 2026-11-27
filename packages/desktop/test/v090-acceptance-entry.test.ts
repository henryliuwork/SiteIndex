import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { parseAcceptanceArgs, runFromManifest } from "../scripts/acceptance/run.mjs";
import { parseItemRange } from "../scripts/acceptance/runner.mjs";

const args = (items: string, matrix?: string) => ["--items", items, "--baseline", matrix ? "v0.8.5" : "v0.8.4",
  "--candidate", matrix ? "c/version-0.9.0" : "c/version-0.8.5",
  "--manifest", "synthetic-pins.json", "--output-dir", "synthetic-out",
  ...(matrix ? ["--matrix", matrix] : [])];

describe("v0.9.0 configurable acceptance entry", () => {
  it("keeps the old 1–83 range and bounds the new matrix to 84–86", () => {
    assert.equal(parseAcceptanceArgs(args("1-83")).itemIds.length, 83);
    assert.deepEqual(parseAcceptanceArgs(args("84-86", "v090")).itemIds, [84, 85, 86]);
    assert.deepEqual(parseItemRange("84,86", { min: 84, max: 86 }), [84, 86]);
    assert.throws(() => parseAcceptanceArgs(args("84")), /outside 1-83/u);
    assert.throws(() => parseAcceptanceArgs(args("83", "v090")), /outside 84-86/u);
    assert.throws(() => parseAcceptanceArgs(args("87", "v090")), /outside 84-86/u);
    assert.throws(() => parseAcceptanceArgs(args("84", "unknown")), /Unknown acceptance matrix/u);
  });

  it("uses pinned v0.8.5 baseline and candidate refs with a packaged sort adapter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-entry-"));
    try {
      const manifest = path.join(root, "synthetic-pins.json");
      await writeFile(manifest, JSON.stringify({ baseline: { ref: "v0.8.5", kind: "release" },
        candidate: { ref: "c/version-0.9.0", kind: "run-artifact" } }));
      const options = { ...parseAcceptanceArgs(args("84", "v090")), manifest,
        outputDir: path.join(root, "out") };
      const run = vi.fn(async (_input: Record<string, unknown>) => ({ items: [], cleanup: { status: "passed" } }));
      await runFromManifest(options, { run });
      assert.equal(run.mock.calls.length, 1);
      assert.equal(typeof (run.mock.calls[0]![0] as { handlers: Record<number, { candidateUi: unknown }> }).handlers[84]?.candidateUi, "function");

      const noop = async () => undefined;
      const handler = { baselineUi: noop, verifyBaselineIpc: noop, verifyBaselineFile: noop,
        candidateUi: noop, verifyCandidateIpc: noop, verifyCandidateFile: noop };
      await runFromManifest(options, { run, extraHandlers: { 84: handler } });
      const submitted = run.mock.calls[1]![0] as {
        itemIds: number[]; itemBounds: { min: number; max: number; baselineRef: string };
        baseline: { ref: string }; candidate: { ref: string };
      };
      assert.deepEqual(submitted.itemIds, [84]);
      assert.deepEqual(submitted.itemBounds, { min: 84, max: 86, baselineRef: "v0.8.5" });
      assert.equal(submitted.baseline.ref, "v0.8.5");
      assert.equal(submitted.candidate.ref, "c/version-0.9.0");
      await assert.rejects(() => runFromManifest({ ...options, baselineRef: "v0.8.4" },
        { run, extraHandlers: { 84: handler } }), /do not match/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("connects packaged sort, search and discovery rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-search-entry-"));
    try {
      const manifest = path.join(root, "synthetic-pins.json");
      await writeFile(manifest, JSON.stringify({ baseline: { ref: "v0.8.5", kind: "release" },
        candidate: { ref: "c/version-0.9.0", kind: "run-artifact" } }));
      const run = vi.fn(async (input: { handlers: Record<number, Record<string, unknown>> }) => {
        assert.deepEqual(Object.keys(input.handlers), ["85"]);
        assert.equal(typeof input.handlers[85]?.candidateUi, "function");
        return { items: [], cleanup: { status: "passed" } };
      });
      const options = { ...parseAcceptanceArgs(args("85", "v090")), manifest,
        outputDir: path.join(root, "out") };
      await runFromManifest(options, { run });
      assert.equal(run.mock.calls.length, 1);
      const discovery = { ...options, itemIds: [86], itemsArgument: "86" };
      await runFromManifest(discovery, { run: vi.fn(async (input: { handlers: Record<number, Record<string, unknown>> }) => {
        assert.deepEqual(Object.keys(input.handlers), ["86"]);
        assert.equal(typeof input.handlers[86]?.candidateUi, "function");
        return { items: [], cleanup: { status: "passed" } };
      }) });
      await runFromManifest({ ...options, itemIds: [84], itemsArgument: "84" }, { run: vi.fn(async (input: { handlers: Record<number, Record<string, unknown>> }) => {
        assert.deepEqual(Object.keys(input.handlers), ["84"]);
        assert.equal(typeof input.handlers[84]?.candidateUi, "function");
        return { items: [], cleanup: { status: "passed" } };
      }) });
      assert.equal(run.mock.calls.length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
