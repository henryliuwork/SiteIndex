import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { verifyRemoteSource, verifyRemoteSources } from "../scripts/acceptance/source-provenance.mjs";

const commit = "a".repeat(40);
const archiveSha256 = "c".repeat(64);
const common = { file: "synthetic.exe", commit, runId: 123, workflowId: 99,
  artifactId: 456, sha256: "b".repeat(64), event: "workflow_dispatch" };
const baseline = { ...common, kind: "release", ref: "v0.8.0", artifact: "SiteIndex-Setup-0.8.0.exe" };
const candidate = { ...common, kind: "run-artifact", ref: "v0.8.5-rc.1",
  artifact: "siteindex-win", archiveSha256 };

function api(overrides: Record<string, unknown> = {}) {
  const response = (body: object) => ({ ok: true, status: 200, json: async () => body });
  return vi.fn(async (url: string) => {
    if (url.endsWith("actions/runs/123")) return response({ id: 123, workflow_id: 99,
      head_sha: commit, status: "completed", conclusion: "success", event: "workflow_dispatch",
      repository: { full_name: "henryliuwork/SiteIndex" }, ...overrides });
    if (url.endsWith("actions/artifacts/456")) return response({ id: 456, name: "siteindex-win",
      expired: false, digest: `sha256:${archiveSha256}`,
      workflow_run: { id: 123, head_sha: commit } });
    if (url.endsWith("releases/tags/v0.8.0")) return response({ tag_name: "v0.8.0", draft: false,
      assets: [{ id: 456, name: "SiteIndex-Setup-0.8.0.exe" }] });
    if (url.endsWith("commits/v0.8.0")) return response({ sha: commit });
    throw new Error("Unexpected synthetic GitHub route");
  });
}

describe("v0.8.5 pinned GitHub installer provenance", () => {
  it("verifies both successful workflow runs, Release asset and Actions artifact", async () => {
    const request = api();
    const result = await verifyRemoteSources(baseline, candidate, { request, token: "synthetic-token" });
    assert.equal(result.baseline.provenance, "verified");
    assert.equal(result.candidate.provenance, "verified");
    assert.equal(request.mock.calls.length, 5);
  });

  it("rejects failed runs before accepting an artifact", async () => {
    const request = api({ conclusion: "failure" });
    await assert.rejects(() => verifyRemoteSource(candidate, { request, token: "synthetic-token" }),
      /run conclusion/u);
    assert.equal(request.mock.calls.length, 1);
  });

  it("rejects missing provenance fields without contacting GitHub", async () => {
    const request = api();
    await assert.rejects(() => verifyRemoteSource({ ...candidate, workflowId: undefined },
      { request, token: "synthetic-token" }), /workflow ID/u);
    assert.equal(request.mock.calls.length, 0);
  });

  it("rejects an Actions archive digest mismatch", async () => {
    const request = api();
    await assert.rejects(() => verifyRemoteSource({ ...candidate, archiveSha256: "d".repeat(64) },
      { request, token: "synthetic-token" }), /archive SHA256/u);
  });
});
