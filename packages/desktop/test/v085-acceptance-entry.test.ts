import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { acceptanceHandlers, parseAcceptanceArgs, runFromManifest } from
  "../scripts/acceptance/run.mjs";

describe("v0.8.5 single acceptance entry", () => {
  it("parses one bounded range and wires every frozen matrix item", () => {
    const options = parseAcceptanceArgs(["--items", "1-83", "--baseline", "v0.8.4",
      "--candidate", "c/version-0.8.5", "--manifest", "pins.json", "--output-dir", "out"]);
    assert.equal(options.itemIds.length, 83);
    assert.equal(options.itemsArgument, "1-83");
    const handlers = acceptanceHandlers(options.itemIds, {
      username: "synthetic", applicationPassword: "synthetic-canary",
    });
    assert.deepEqual(Object.keys(handlers).map(Number), options.itemIds);
    for (const id of options.itemIds) {
      for (const phase of ["baselineUi", "verifyBaselineIpc", "verifyBaselineFile",
        "candidateUi", "verifyCandidateIpc", "verifyCandidateFile"]) {
        assert.equal(typeof handlers[id][phase], "function", `row ${id} ${phase}`);
      }
    }
    assert.throws(() => parseAcceptanceArgs(["--items", "1,1", "--baseline", "v0.8.4",
      "--candidate", "c/version-0.8.5", "--manifest", "pins.json", "--output-dir", "out"]), /Duplicate/u);
  });

  it("uses exact refs from the pinned manifest and passes runtime secrets only to the report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-entry-"));
    try {
      const file = path.join(root, "pins.json");
      await writeFile(file, JSON.stringify({ baseline: { ref: "v0.8.4", kind: "release" },
        candidate: { ref: "c/version-0.8.5", kind: "run-artifact" } }));
      const options = { itemIds: [82], itemsArgument: "82", baselineRef: "v0.8.4", candidateRef: "c/version-0.8.5",
        manifest: file, outputDir: path.join(root, "out") };
      const run = vi.fn(async (_input: Record<string, unknown>) => ({ items: [], cleanup: { status: "passed" } }));
      await runFromManifest(options, { run });
      const passed = run.mock.calls[0][0];
      assert.equal(passed.itemsArgument, "82");
      assert.equal(passed.secrets.length, 2);
      assert.equal(passed.secrets.every((value: string) => value.length > 8), true);
      assert.equal((await readFile(file, "utf8")).includes(passed.secrets[1]), false);
      await assert.rejects(() => runFromManifest({ ...options, candidateRef: "wrong" }, { run }), /do not match/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
