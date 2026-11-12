import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const matrixUrl = new URL("./v041-candidate-package-cases.json", import.meta.url);
const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));

const expectedCaseIds = [
  "PKG-NSIS-UPGRADE",
  "PKG-STORAGE-READONLY",
  "PKG-STOCK-ABSENT-STATES",
  "PKG-MEDIA-RECOVERY",
  "PKG-EDM-SAVEAS-CANCEL",
  "PKG-EDM-CONFLICT",
  "PKG-CREDENTIAL-ISOLATION",
];

const requiredArrays = ["dependencies", "automated", "manual_required", "pass", "evidence"];
const profileEnvironment = ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"];

test("candidate package matrix includes all requested synthetic acceptance areas", () => {
  assert.equal(matrix.schema_version, 1);
  assert.equal(matrix.candidate_version, "0.4.1");
  assert.match(matrix.baseline.main_commit, /^[0-9a-f]{40}$/u);

  const actualCaseIds = matrix.cases.map(({ id }) => id);
  assert.deepEqual(actualCaseIds, expectedCaseIds);
  assert.equal(new Set(actualCaseIds).size, expectedCaseIds.length);
});

test("each case has dependencies, automation, manual notes, pass criteria, and evidence", () => {
  for (const testCase of matrix.cases) {
    assert.equal(typeof testCase.area, "string", testCase.id);
    assert.equal(typeof testCase.readiness, "string", testCase.id);
    for (const field of requiredArrays) {
      assert.ok(Array.isArray(testCase[field]), testCase.id + " " + field);
      assert.ok(testCase[field].length > 0, testCase.id + " " + field);
      assert.ok(testCase[field].every((item) => typeof item === "string" && item.trim().length > 0), testCase.id + " " + field);
    }
  }
});

test("isolation plan redirects the full profile and keeps data synthetic", () => {
  assert.match(matrix.isolation.runner, /GitHub-hosted Windows/u);
  assert.match(matrix.isolation.root, /RUNNER_TEMP/u);
  assert.deepEqual(matrix.isolation.profile_environment, profileEnvironment);
  assert.equal(matrix.isolation.synthetic_data_only, true);
  assert.equal(matrix.isolation.restore_and_cleanup_required, true);
  assert.match(matrix.isolation.network_policy, /loopback fixtures only/u);
  assert.ok(matrix.isolation.forbidden.some((item) => /real project/i.test(item)));
  assert.ok(matrix.isolation.forbidden.some((item) => /release publishing/i.test(item)));
});

test("pending package features remain gated", () => {
  const byId = new Map(matrix.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(byId.get("PKG-STORAGE-READONLY").readiness, "core-ready-ui-pending");
  assert.ok(byId.get("PKG-STORAGE-READONLY").dependencies.some((dependency) => dependency.includes("#484")));
  assert.equal(byId.get("PKG-MEDIA-RECOVERY").readiness, "hosted-win-unpacked-only-nsis-pending");
  assert.equal(byId.get("PKG-EDM-SAVEAS-CANCEL").readiness, "blocked-until-edm-export-handler");
  assert.ok(byId.get("PKG-EDM-SAVEAS-CANCEL").dependencies.some((dependency) => dependency.includes("#481")));
  assert.equal(byId.get("PKG-EDM-CONFLICT").readiness, "blocked-until-edm-export-handler");
});

test("manifest contains no local paths, external URLs, or embedded credential values", async () => {
  const serialized = await readFile(matrixUrl, "utf8");
  assert.doesNotMatch(serialized, /[A-Za-z]:\\/u);
  assert.doesNotMatch(serialized, /https?:\/\//iu);
  assert.doesNotMatch(serialized, /"(?:username|password|token|authorization)"\s*:/iu);
});
