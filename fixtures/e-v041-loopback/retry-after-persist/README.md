# Persisted upload retry fixture

This E-owned fixture isolates one WordPress failure window that current `main`
cannot configure: the media POST stores an object, then responds with HTTP 429.
The service also provides the already-needed persist-then-disconnect window so
both uncertain outcomes can be checked with the same retry probe.

## Evidence scope

- Current `main` is `b4073524df0fa8fe6487c1a64380ad497e5de659`. Its shared fake
  WordPress service supports `disconnectAfterPersist`, GET-by-slug lookup, and
  ordinary 429 throttling. Throttling happens before media persistence, while a
  scripted non-201 POST response also returns before persistence.
- Open PR #439 latest head at inspection is
  `54cfbbd489e9b2a7915c6d18cd65933c49089a39`. It adds
  `persistMediaBeforePostFailure` and persisted 422/429/500/302 case vectors.
  The PR's `job-export-acceptance.test.mjs` was unchanged at that head and
  still asserts the old exact case ID list, so running it against the updated
  vector would reject the list until the test is updated. Latest-head CI run
  `43052780242` passed, but that does not prove the standalone Node fixture
  runner was executed. This E fixture independently tests the error and retry
  distinction without importing the unmerged A implementation.
- The retry probe in the test is a small expected-flow oracle: after an
  uncertain POST, it GETs the synthetic slug and reuses an existing object
  without another POST. A separate preflight vector represents a local
  validation failure before any HTTP request, after which a later valid
  synthetic SKU can be sent. It does **not** call SiteIndex Core, CLI, Desktop
  IPC, or UI, so it proves the mock scenarios are expressible, not that the
  product follows either behavior.
- The existing legacy CSV and extended expected CSV are checked as input and
  migration oracle only. The test does not execute the product's ledger
  migration.

The service binds only to `127.0.0.1` on an ephemeral port. It consumes but
does not retain request bodies or headers; snapshots contain fixed route names,
status/outcome counts and object count. All credentials and media identifiers
are synthetic.

Run with:

```sh
node --test fixtures/e-v041-loopback/retry-after-persist/fake-media-origin.test.mjs
```
