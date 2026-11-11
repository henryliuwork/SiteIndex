import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createFakeCredentialCanary, scanCredentialCanary } from "../fake-services.mjs";
import { createRetryWordPressService } from "./fake-media-origin.mjs";

const CASES_URL = new URL("./acceptance-cases.json", import.meta.url);
const LEGACY_LEDGER_URL = new URL("../media-export/legacy-sku-media.csv", import.meta.url);
const EXTENDED_LEDGER_URL = new URL("../media-export/extended-sku-media.expected.csv", import.meta.url);

async function readCases() {
  return JSON.parse(await readFile(CASES_URL, "utf8"));
}

async function upload(service, credentials, slug) {
  return fetch(service.mediaEndpoint, {
    method: "POST",
    headers: {
      authorization: credentials.authorization,
      "content-type": "image/jpeg",
      "x-fake-wp-slug": slug,
    },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
}

async function retryBySlug(service, credentials, slug) {
  const lookup = await fetch(`${service.mediaEndpoint}?slug=${encodeURIComponent(slug)}`, {
    headers: { authorization: credentials.authorization },
  });
  assert.equal(lookup.status, 200);
  const matches = await lookup.json();
  if (matches.length > 0) return { kind: "reused", media: matches[0] };

  const post = await upload(service, credentials, slug);
  if (post.status !== 201) return { kind: "failed", status: post.status };
  return { kind: "created", media: await post.json() };
}

describe("E retry-after-persist WordPress fixture", () => {
  it("declares the retry and old-ledger vectors as fixture-only oracles", async () => {
    const cases = await readCases();
    assert.match(cases.evidence_scope, /^fixture-only/u);
    assert.equal(cases.preflight_continue_case.local_failure.http_request_sent, false);
    assert.equal(cases.preflight_continue_case.core_acceptance_oracle.continue_after_preflight_failure, true);
    assert.deepEqual(cases.persisted_error_cases.map(({ id }) => id), [
      "MEDIA-persist-then-422-unknown-stop",
      "MEDIA-persist-then-429-unknown-stop",
      "MEDIA-persist-then-500-unknown-stop",
      "MEDIA-persist-then-disconnect-unknown-stop",
    ]);
    assert.equal(cases.legacy_ledger_case.legacy_columns.length, 8);
    assert.deepEqual(cases.legacy_ledger_case.first_write_appends, ["media_id", "source_hash"]);
  });

  it("keeps the no-request continue oracle separate from sent-request unknown oracles", async () => {
    const cases = await readCases();
    const preflight = cases.preflight_continue_case;
    assert.equal(preflight.local_failure.point, "before_http_request");
    assert.equal(preflight.local_failure.http_request_sent, false);
    assert.equal(preflight.core_acceptance_oracle.continue_after_preflight_failure, true);

    for (const scenario of cases.persisted_error_cases) {
      assert.equal(scenario.core_acceptance_oracle.media_batch_state, "outcome_unknown");
      assert.equal(scenario.core_acceptance_oracle.stop_batch_after_sent_post, true);
      assert.deepEqual(scenario.core_acceptance_oracle.media_unknown_skus, [scenario.sku_sent]);
      assert.deepEqual(scenario.core_acceptance_oracle.media_not_started_skus, [scenario.sku_not_started]);
      assert.notEqual(scenario.sku_sent, scenario.sku_not_started);
    }
  });

  it("continues after a preflight failure only when no HTTP request was sent", async () => {
    const cases = await readCases();
    const scenario = cases.preflight_continue_case;
    const credentials = createFakeCredentialCanary();
    const service = await createRetryWordPressService({
      credentials,
      firstPostMode: "persist_then_201",
    });

    try {
      assert.equal(service.boundHost, "127.0.0.1");
      assert.equal(scenario.local_failure.http_request_sent, false);
      const knownLocalFailure = {
        sku: scenario.local_failure.sku,
        outcome: scenario.local_failure.expected_result,
      };
      const followupSlug = `synthetic-${scenario.next_valid_sku.toLowerCase()}`;
      const followup = await upload(service, credentials, followupSlug);
      assert.equal(followup.status, scenario.expected_followup_http_status);

      const snapshot = service.snapshot();
      assert.deepEqual(knownLocalFailure, {
        sku: "SYN-E-NO-SOURCE",
        outcome: "failed_known_no_side_effect",
      });
      assert.equal(snapshot.routeCounts["POST /wp-json/wp/v2/media"], 1);
      assert.equal(snapshot.mediaCount, 1);
      assert.equal(snapshot.requestBodiesRecorded, false);
      assert.equal(snapshot.requestHeadersRecorded, false);
      assert.equal(scanCredentialCanary({ snapshot, knownLocalFailure }, credentials).passed, true);
    } finally {
      await service.close();
    }
  });

  it("marks sent POST outcomes unknown, stops before the next SKU, then reconciles by slug", async () => {
    const cases = await readCases();
    for (const scenario of cases.persisted_error_cases) {
      const credentials = createFakeCredentialCanary();
      const service = await createRetryWordPressService({
        credentials,
        firstPostMode: scenario.first_post_mode,
      });
      const slug = `synthetic-${scenario.sku_sent.toLowerCase()}`;

      try {
        if (scenario.first_post_status === "disconnect") {
          await assert.rejects(upload(service, credentials, slug));
        } else {
          const first = await upload(service, credentials, slug);
          assert.equal(first.status, scenario.first_post_status);
          const body = await first.json();
          assert.equal(body.code, scenario.first_post_status === 429 ? "rest_rate_limited" : "rest_upload_failed");
          if (scenario.first_post_status === 429) assert.equal(first.headers.get("retry-after"), "0");
        }

        const afterUnknown = service.snapshot();
        assert.equal(afterUnknown.postAttempts, scenario.expected_post_attempts_before_retry);
        assert.equal(afterUnknown.mediaCount, scenario.expected_media_count);
        assert.equal(afterUnknown.routeCounts["POST /wp-json/wp/v2/media"], 1);
        assert.equal(afterUnknown.outcomeCounts[scenario.first_post_outcome], 1);

        const retry = await retryBySlug(service, credentials, slug);
        assert.equal(retry.kind, "reused");
        const afterRetry = service.snapshot();
        assert.equal(afterRetry.routeCounts["POST /wp-json/wp/v2/media"], 1);
        assert.equal(afterRetry.routeCounts["GET /wp-json/wp/v2/media"], 1);
        assert.equal(afterRetry.mediaCount, scenario.expected_media_count);
        assert.equal(scanCredentialCanary({ afterUnknown, afterRetry, retry }, credentials).passed, true);
      } finally {
        await service.close();
      }
    }
  });

  it("checks the legacy ledger migration oracle without modifying its source bytes", async () => {
    const cases = await readCases();
    const sourceBefore = await readFile(LEGACY_LEDGER_URL);
    const sourceAfterRead = await readFile(LEGACY_LEDGER_URL);
    const extended = await readFile(EXTENDED_LEDGER_URL, "utf8");
    const sourceLines = sourceBefore.toString("utf8").trimEnd().split(/\r?\n/u);
    const extendedLines = extended.trimEnd().split(/\r?\n/u);
    const sourceHeader = sourceLines[0].split(",");
    const extendedHeader = extendedLines[0].split(",");

    assert.deepEqual(sourceHeader, cases.legacy_ledger_case.legacy_columns);
    assert.deepEqual(extendedHeader.slice(-2), cases.legacy_ledger_case.first_write_appends);
    assert.equal(sourceLines.length - 1, extendedLines.length - 2);
    for (let index = 1; index < sourceLines.length; index += 1) {
      const oldRow = sourceLines[index].split(",");
      const migratedRow = extendedLines[index].split(",");
      assert.deepEqual(migratedRow.slice(0, sourceHeader.length), oldRow);
      assert.deepEqual(migratedRow.slice(sourceHeader.length), cases.legacy_ledger_case.legacy_rows_appended_values);
    }
    assert.deepEqual(sourceAfterRead, sourceBefore);
  });
});
