const REPOSITORY = "henryliuwork/SiteIndex";
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;

async function githubJson(resource, { request, token }) {
  const response = await request(`${API_ROOT}/${resource}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GitHub provenance lookup failed (HTTP ${response.status})`);
  return response.json();
}

function assertSame(actual, expected, label) {
  if (actual !== expected) throw new Error(`Pinned GitHub ${label} does not match`);
}

/** Verifies an immutable run plus either its Actions artifact or its published Release asset. */
export async function verifyRemoteSource(source, { request = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  if (!token) throw new Error("GitHub provenance token is required");
  if (!["run-artifact", "release"].includes(source.kind)
    || !Number.isInteger(source.workflowId) || source.workflowId <= 0
    || !source.event) throw new Error("Pinned source kind, workflow ID and event are required");
  const run = await githubJson(`actions/runs/${source.runId}`, { request, token });
  assertSame(run.id, source.runId, "run ID");
  assertSame(run.workflow_id, source.workflowId, "workflow ID");
  assertSame(run.head_sha?.toLowerCase(), source.commit.toLowerCase(), "commit");
  assertSame(run.event, source.event, "event");
  assertSame(run.status, "completed", "run status");
  assertSame(run.conclusion, "success", "run conclusion");
  if (run.repository?.full_name) assertSame(run.repository.full_name, REPOSITORY, "repository");

  if (source.kind === "run-artifact") {
    if (!/^[a-f\d]{64}$/iu.test(source.archiveSha256 ?? "")) {
      throw new Error("Pinned Actions archive SHA256 is required");
    }
    const artifact = await githubJson(`actions/artifacts/${source.artifactId}`, { request, token });
    assertSame(artifact.id, source.artifactId, "artifact ID");
    assertSame(artifact.name, source.artifact, "artifact name");
    assertSame(artifact.expired, false, "artifact expiry");
    assertSame(artifact.workflow_run?.id, source.runId, "artifact run");
    assertSame(artifact.workflow_run?.head_sha?.toLowerCase(), source.commit.toLowerCase(), "artifact commit");
    assertSame(artifact.digest?.replace(/^sha256:/u, "").toLowerCase(),
      source.archiveSha256.toLowerCase(), "artifact archive SHA256");
  } else {
    const release = await githubJson(`releases/tags/${encodeURIComponent(source.ref)}`, { request, token });
    assertSame(release.tag_name, source.ref, "release tag");
    assertSame(release.draft, false, "release publication");
    const asset = release.assets?.find((entry) => entry.id === source.artifactId);
    assertSame(asset?.name, source.artifact, "Release asset");
    const taggedCommit = await githubJson(`commits/${encodeURIComponent(source.ref)}`, { request, token });
    assertSame(taggedCommit.sha?.toLowerCase(), source.commit.toLowerCase(), "release commit");
  }
  return { ref: source.ref, commit: source.commit, runId: source.runId,
    artifactId: source.artifactId, kind: source.kind, provenance: "verified" };
}

export async function verifyRemoteSources(baseline, candidate, options) {
  return { baseline: await verifyRemoteSource(baseline, options),
    candidate: await verifyRemoteSource(candidate, options) };
}
