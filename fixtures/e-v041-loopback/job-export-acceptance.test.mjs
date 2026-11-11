import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import {
  createFakeCredentialCanary,
  createFakeWordPressService,
  scanCredentialCanary,
} from "./fake-services.mjs";

const fixtureDirectory = new URL("./", import.meta.url);
const openedServices = new Set();

after(async () => {
  await Promise.all([...openedServices].map((service) => service.close()));
  openedServices.clear();
});

async function readFixture(path) {
  return readFile(new URL(path, fixtureDirectory), "utf8");
}

async function track(serviceOptions) {
  const service = await createFakeWordPressService(serviceOptions);
  openedServices.add(service);
  const close = service.close;
  service.close = async () => {
    openedServices.delete(service);
    await close();
  };
  return service;
}

function authHeaders(credentials) {
  return { authorization: credentials.authorization };
}

function upload(service, credentials, slug) {
  return fetch(service.mediaEndpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...authHeaders(credentials),
      "content-type": "image/jpeg",
      "x-fake-wp-slug": slug,
    },
    body: Buffer.from("synthetic image bytes"),
  });
}

async function readCases() {
  return JSON.parse(await readFixture("job-export-cases.json"));
}

describe("v0.4.1 synthetic media Job and EDM export acceptance fixtures", () => {
  it("declares the requested media and export cases without claiming product execution", async () => {
    const cases = await readCases();
    const mediaCaseIds = cases.media_job_cases.map(({ id }) => id);
    const exportCaseIds = cases.export_index_cases.map(({ id }) => id);

    assert.equal(cases.evidence_scope.startsWith("fixture-only"), true);
    assert.deepEqual(mediaCaseIds, [
      "MEDIA-401-after-confirmed-item",
      "MEDIA-403-after-confirmed-item",
      "MEDIA-422-after-persist",
      "MEDIA-local-missing-image-then-continue",
      "MEDIA-429-after-persist",
      "MEDIA-500-after-persist",
      "MEDIA-302-after-persist",
      "MEDIA-save-then-disconnect",
      "MEDIA-same-day-rerun-and-deduplicate-request",
      "MEDIA-legacy-ledger-read-before-first-write",
      "MEDIA-old-run-log-is-not-an-empty-recovery-result",
      "SEC-fake-credential-canary",
    ]);
    assert.deepEqual(exportCaseIds, [
      "EXP-synthetic-golden-input",
      "EXP-same-day-rerun",
      "EXP-legacy-ledger-is-read-only",
      "EXP-unmarked-target-conflict",
      "EXP-target-edited-after-read",
      "EXP-target-created-after-absence-check",
      "EXP-write-completed-response-lost",
      "EXP-path-escape-or-reparse-point",
    ]);
    for (const testCase of cases.media_job_cases) {
      const oracle = testCase.core_acceptance_oracle;
      if (!oracle.media_batch_state) continue;
      const results = oracle.media_results.map(({ sku }) => sku);
      const unknown = oracle.media_unknown_skus;
      const notStarted = oracle.media_not_started_skus;
      assert.equal(new Set([...results, ...unknown, ...notStarted]).size, testCase.request_skus.length);
      assert.deepEqual([...results, ...unknown, ...notStarted], testCase.request_skus);
    }
    assert.match(cases.evidence_scope, /do not invoke SiteIndex Job, Core, CLI, Desktop IPC, or UI/u);
    assert.match(cases.notes.join("\n"), /not evidence that SiteIndex produced it/u);
  });

  it("serves scripted 401 and 403 after one persisted item and records only counts", async () => {
    const cases = await readCases();
    const authorizationCases = cases.media_job_cases.filter(({ id }) =>
      id === "MEDIA-401-after-confirmed-item" || id === "MEDIA-403-after-confirmed-item");

    for (const testCase of authorizationCases) {
      const credentials = createFakeCredentialCanary();
      const service = await track({
        credentials,
        mediaPostStatuses: testCase.fake_wordpress.media_post_statuses,
      });
      assert.equal(service.boundHost, "127.0.0.1");

      const responses = [];
      for (const [index, sku] of testCase.fixture_probe_posts.entries()) {
        const response = await upload(service, credentials, sku.toLowerCase() + "-main");
        responses.push(response.status);
        if (response.status !== 201) {
          const body = await response.json();
          assert.equal(body.data.status, response.status);
          assert.equal(body.code, response.status === 401 ? "rest_not_logged_in" : "rest_forbidden");
        }
        if (index === 0) assert.equal(response.status, 201);
      }

      assert.deepEqual(responses, testCase.expected_fixture_responses);
      assert.equal(service.snapshot().totalRequests, 2);
      assert.equal(service.snapshot().mediaCount, 1);
      assert.equal(service.snapshot().requestBodiesRecorded, false);
      assert.equal(service.snapshot().requestHeadersRecorded, false);
    }
  });

  it("serves ambiguous 422, 429, 5xx, and redirect outcomes after persistence, then exposes exact-slug recovery", async () => {
    const cases = await readCases();
    const ambiguous = cases.media_job_cases.filter(({ id }) => [
      "MEDIA-422-after-persist", "MEDIA-429-after-persist", "MEDIA-500-after-persist", "MEDIA-302-after-persist",
    ].includes(id));

    for (const testCase of ambiguous) {
      const credentials = createFakeCredentialCanary();
      const service = await track({
        credentials,
        mediaPostStatuses: testCase.fake_wordpress.media_post_statuses,
        persistMediaBeforePostFailure: testCase.fake_wordpress.persist_before_post_failure,
      });
      const sku = testCase.fixture_probe_posts[0];
      const slug = sku.toLowerCase() + "-main";
      const response = await upload(service, credentials, slug);
      assert.equal(response.status, testCase.expected_fixture_responses[0]);
      if (response.status !== 302) {
        const error = await response.json();
        assert.equal(error.data.status, response.status);
      }

      const lookup = await fetch(service.mediaEndpoint + "?slug=" + slug, { headers: authHeaders(credentials) });
      assert.equal(lookup.status, 200);
      assert.equal((await lookup.json())[0].slug, slug);
      assert.equal(service.snapshot().routeCounts["POST /wp-json/wp/v2/media"], 1);
      assert.equal(service.snapshot().routeCounts["GET /wp-json/wp/v2/media"], 1);
      assert.equal(service.snapshot().mediaCount, 1);
      assert.equal(service.snapshot().statusCounts[String(response.status)], 1);
    }
  });

  it("records a deterministic local missing-image case whose later SKU can still be processed", async () => {
    const cases = await readCases();
    const testCase = cases.media_job_cases.find(({ id }) => id === "MEDIA-local-missing-image-then-continue");
    assert.deepEqual(testCase.missing_image_skus, [testCase.request_skus[0]]);
    assert.deepEqual(testCase.fixture_probe_posts, [testCase.request_skus[1]]);
    assert.deepEqual(testCase.expected_fixture_responses, [201]);
    assert.deepEqual(testCase.core_acceptance_oracle.media_results, [
      { sku: testCase.request_skus[0], status: "failed" },
      { sku: testCase.request_skus[1], status: "uploaded" },
    ]);
  });

  it("keeps a saved upload discoverable after a lost response without retrying POST", async () => {
    const cases = await readCases();
    const testCase = cases.media_job_cases.find(({ id }) => id === "MEDIA-save-then-disconnect");
    const credentials = createFakeCredentialCanary();
    const service = await track({
      credentials,
      disconnectAfterPersist: testCase.fake_wordpress.disconnect_after_persist,
    });

    await assert.rejects(upload(service, credentials, testCase.fixture_probe_lookup_slug + ".jpg"));
    const lookup = await fetch(service.mediaEndpoint + "?slug=" + testCase.fixture_probe_lookup_slug, {
      headers: authHeaders(credentials),
    });
    assert.equal(lookup.status, 200);
    const matches = await lookup.json();
    assert.equal(matches.length, 1);
    assert.equal(matches[0].slug, testCase.fixture_probe_lookup_slug);
    assert.equal(service.snapshot().routeCounts["POST /wp-json/wp/v2/media"], 1);
    assert.equal(service.snapshot().routeCounts["GET /wp-json/wp/v2/media"], 1);
    assert.equal(service.snapshot().mediaCount, 1);
    assert.equal(service.snapshot().outcomeCounts.persisted_then_disconnected, 1);
  });

  it("checks fake canaries across named output surfaces and returns only leak categories", async () => {
    const cases = await readCases();
    const testCase = cases.media_job_cases.find(({ id }) => id === "SEC-fake-credential-canary");
    const credentials = createFakeCredentialCanary();
    const safeSurfaces = Object.fromEntries(testCase.surfaces_to_scan.map((surface) => [surface, {
      code: "WP_AUTH_FAILED",
      message: "Synthetic authentication failed.",
      status: "interrupted",
      count: 1,
    }]));
    const safeReport = scanCredentialCanary(safeSurfaces, credentials);
    assert.equal(safeReport.passed, true);
    assert.equal(safeReport.matchCount, 0);

    const unsafeSurfaces = {
      ...safeSurfaces,
      "run-log": { detail: credentials.authorization },
    };
    const leakReport = scanCredentialCanary(unsafeSurfaces, credentials);
    assert.equal(leakReport.passed, false);
    assert.deepEqual(leakReport.matchedKinds, ["basicToken", "authorizationHeader"]);
    for (const secret of [credentials.username, credentials.applicationPassword, credentials.basicToken, credentials.authorization]) {
      assert.equal(JSON.stringify(leakReport).includes(secret), false);
    }
  });

  it("provides an eight-column legacy ledger and a ten-column append-only migration oracle", async () => {
    const cases = await readCases();
    const oldRows = (await readFixture("media-export/legacy-sku-media.csv")).trimEnd().split("\n").map((line) => line.split(","));
    const migratedRows = (await readFixture("media-export/extended-sku-media.expected.csv")).trimEnd().split("\n").map((line) => line.split(","));
    const oldHeader = ["sku", "image_role", "image_url", "alt_text", "source", "width", "height", "updated_at"];
    const extendedHeader = [...oldHeader, "media_id", "source_hash"];

    assert.deepEqual(oldRows[0], oldHeader);
    assert.deepEqual(migratedRows[0], extendedHeader);
    for (const oldRow of oldRows.slice(1)) {
      const migrated = migratedRows.find((row) => row[0] === oldRow[0] && row[1] === oldRow[1]);
      assert.ok(migrated);
      assert.deepEqual(migrated.slice(0, oldHeader.length), oldRow);
      assert.deepEqual(migrated.slice(oldHeader.length), ["", ""]);
    }
    assert.equal(migratedRows.at(-1)[4], "wordpress");
    assert.equal(migratedRows.at(-1)[8], "7001");
    assert.match(migratedRows.at(-1)[9], /^[a-f0-9]{64}$/u);
    assert.equal(migratedRows.at(-1)[9], createHash("sha256").update("synthetic image bytes", "utf8").digest("hex"));
    const ledgerCase = cases.export_index_cases.find(({ id }) => id === "EXP-legacy-ledger-is-read-only");
    const legacyBytes = await readFixture(ledgerCase.ledger);
    assert.equal(createHash("sha256").update(legacyBytes, "utf8").digest("hex"), ledgerCase.expected_ledger_sha256);
  });

  it("keeps an old media RunLog without recovery fields as explicitly unrecoverable", async () => {
    const cases = await readCases();
    const testCase = cases.media_job_cases.find(({ id }) => id === "MEDIA-old-run-log-is-not-an-empty-recovery-result");
    const legacyLine = await readFixture(testCase.input_fixture);
    const oldRun = JSON.parse(legacyLine);

    assert.equal(oldRun.job, "media");
    assert.equal(oldRun.status, "partial");
    for (const key of testCase.recovery_fields_expected_absent) assert.equal(Object.hasOwn(oldRun, key), false);
    assert.deepEqual(testCase.core_acceptance_oracle, {
      recovery_state: "unrecoverable",
      infer_empty_media_results: false,
      rewrite_legacy_line_on_read: false,
    });
    assert.equal(legacyLine.endsWith("\n"), true);
  });

  it("provides existing media rows for same-day skip and duplicate-request ordering", async () => {
    const cases = await readCases();
    const testCase = cases.media_job_cases.find(({ id }) => id === "MEDIA-same-day-rerun-and-deduplicate-request");
    const rows = (await readFixture(testCase.same_day_ledger_fixture)).trimEnd().split("\n").map((line) => line.split(","));

    assert.deepEqual(testCase.expected_deduplicated_request_order, testCase.same_day_existing_ledger_skus);
    assert.deepEqual(rows.slice(1).map((row) => row[0]), testCase.same_day_existing_ledger_skus);
    assert.ok(rows.slice(1).every((row) => row[2].startsWith("https://synthetic-wp.invalid/")));
    assert.ok(rows.slice(1).every((row) => row[4] === "wordpress" && row[8] && row[9]));
    assert.equal(testCase.core_acceptance_oracle.repeat_run_posts, 0);
  });

  it("keeps the EDM golden fixture deterministic and limited to spec-defined fields", async () => {
    const cases = await readCases();
    const testCase = cases.export_index_cases.find(({ id }) => id === "EXP-synthetic-golden-input");
    const products = (await readFixture("media-export/views-products.jsonl")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const output = await readFixture("media-export/sku-index.expected.md");

    assert.deepEqual(products.map(({ skus }) => skus[0]), ["SYN-A001", "SYN-B001", "SYN-C001"]);
    assert.ok(output.startsWith("<!-- siteindex:generated:edm-sku-index:v1 -->\n# EDM SKU Index\n"));
    assert.match(output, /\| Synthetic Beta \\\| Series \| Synthetic \\\| short copy \|/u);
    assert.match(output, /\| SYN-A001 .*\| 待补图 \|/u);
    assert.match(output, /https:\/\/synthetic-cdn\.invalid\/images\/syn-b001\.jpg/u);
    assert.doesNotMatch(output, /\.webp/u);
    assert.equal(output.endsWith("\n"), true);
    assert.equal(Buffer.from(output, "utf8").subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    assert.ok(testCase.fixture_assertions.includes("no discount-tier assertion"));
    assert.equal(createHash("sha256").update(output, "utf8").digest("hex"), testCase.expected_output_sha256);
  });

  it("describes same-day no-op, file conflicts, and post-commit unknown outcome as unexecuted Core oracles", async () => {
    const cases = await readCases();
    const byId = new Map(cases.export_index_cases.map((testCase) => [testCase.id, testCase]));
    const rerun = byId.get("EXP-same-day-rerun");
    assert.deepEqual(rerun.core_acceptance_oracle, {
      first_status: "created",
      second_status: "unchanged",
      output_bytes_equal: true,
      second_write: false,
    });

    const conflictCases = [
      ["EXP-unmarked-target-conflict", "media-export/conflict-unmarked.md"],
      ["EXP-target-edited-after-read", "media-export/conflict-marked-edited.md"],
      ["EXP-target-created-after-absence-check", "media-export/conflict-external-create.md"],
    ];
    for (const [id, path] of conflictCases) {
      const testCase = byId.get(id);
      assert.equal(testCase.target_fixture, path);
      const target = await readFixture(path);
      assert.ok(target.length > 0);
      assert.equal(testCase.core_acceptance_oracle.error_code, "EDM_INDEX_CONFLICT");
    }

    const unknown = byId.get("EXP-write-completed-response-lost");
    assert.equal(unknown.core_acceptance_oracle.error_code, "EDM_EXPORT_OUTCOME_UNKNOWN");
    assert.equal(unknown.core_acceptance_oracle.blind_retry, false);
    assert.match(unknown.core_acceptance_oracle.next_action, /reread target/u);
    assert.equal(byId.get("EXP-path-escape-or-reparse-point").core_acceptance_oracle.fail_closed, true);
  });
});
