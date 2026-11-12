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
  assert.equal(matrix.baseline.main_commit, "bfc55287886f46915d90e2cee1c727cb71c43adb");

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

test("merged implementations remain gated on candidate package evidence", () => {
  const byId = new Map(matrix.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(byId.get("PKG-STORAGE-READONLY").readiness, "candidate-package-pending");
  const storageDependencies = byId.get("PKG-STORAGE-READONLY").dependencies;
  assert.ok(storageDependencies.some((dependency) => dependency.includes("#485")));
  assert.ok(storageDependencies.some((dependency) => dependency.includes("#495") && dependency.includes("merged in main")));
  assert.ok(storageDependencies.some((dependency) => dependency.includes("#480")));
  assert.ok(storageDependencies.some((dependency) => dependency.includes("#484") && dependency.includes("merged in main")));
  assert.match(matrix.dependencies_at_baseline.storage, /Aggregate issue #480 remains open/u);
  const storage = byId.get("PKG-STORAGE-READONLY");
  assert.deepEqual(storage.device_independence, {
    runner_count: 2,
    profile_environment_isolated: true,
    mutations_visible_only_on_origin_runner: true,
    cloud_sync_supported: false,
    real_cloud_sync_test_claimed: false,
  });
  assert.ok(storage.manual_required.some((step) => /unknown-path wording/u.test(step)));
  const media = byId.get("PKG-MEDIA-RECOVERY");
  assert.equal(media.readiness, "hosted-win-unpacked-only-nsis-pending");
  assert.ok(media.dependencies.some((dependency) => dependency.includes("media.prepare is absent")));
  const saveAs = byId.get("PKG-EDM-SAVEAS-CANCEL");
  const conflicts = byId.get("PKG-EDM-CONFLICT");
  assert.equal(saveAs.readiness, "candidate-package-pending");
  assert.ok(saveAs.dependencies.some((dependency) => dependency.includes("#473") && dependency.includes("renderer")));
  assert.ok(saveAs.dependencies.some((dependency) => dependency.includes("#481/#492")));
  assert.ok(saveAs.dependencies.some((dependency) => dependency.includes("#496") && dependency.includes("PENDING_HANDLERS")));
  assert.ok(saveAs.dependencies.some((dependency) => dependency.includes("#494") && dependency.includes("outside this case")));
  assert.equal(conflicts.readiness, "candidate-package-pending");
  assert.ok(!conflicts.dependencies.some((dependency) => /still lists.*PENDING_HANDLERS/u.test(dependency)));
  assert.deepEqual(Object.keys(conflicts.target_conflict_policy), [
    "existing_target_inside_project",
    "existing_target_outside_project_same_content",
    "existing_target_outside_project_different_content",
    "target_created_after_dialog_observed_absent",
    "save_as_cancel",
  ]);
  const policy = conflicts.target_conflict_policy;
  assert.equal(policy.existing_target_inside_project.error_code, "EDM_INDEX_CONFLICT");
  assert.equal(policy.existing_target_inside_project.preserve_exact_bytes, true);
  assert.equal(policy.existing_target_outside_project_same_content.outcome, "unchanged");
  assert.equal(policy.existing_target_outside_project_same_content.preserve_exact_bytes, true);
  assert.equal(policy.existing_target_outside_project_different_content.error_category, "WRITE_FAILED");
  assert.equal(policy.existing_target_outside_project_different_content.error_code, "EDM_INDEX_SAFE_REPLACE_UNAVAILABLE");
  assert.equal(policy.existing_target_outside_project_different_content.preserve_exact_bytes, true);
  assert.equal(policy.target_created_after_dialog_observed_absent.no_clobber, true);
  assert.equal(policy.save_as_cancel.no_file_created_or_changed, true);
});

test("manifest contains no local paths, external URLs, or embedded credential values", async () => {
  const serialized = await readFile(matrixUrl, "utf8");
  assert.doesNotMatch(serialized, /[A-Za-z]:\\/u);
  assert.doesNotMatch(serialized, /https?:\/\//iu);
  assert.doesNotMatch(serialized, /"(?:username|password|token|authorization)"\s*:/iu);
});
