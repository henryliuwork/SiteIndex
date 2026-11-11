# v0.4.1 loopback service fixtures

These reusable HTTP fixtures support E's synthetic acceptance preparation. They use fictional payloads and bind only to `127.0.0.1` on an ephemeral port; they do not call a real GraphQL endpoint, WordPress site, or other external service. HTTP is limited to this test-only loopback fixture and does not change the production HTTPS requirement.

`fake-services.mjs` exports:

- `createFakeGraphqlService`: synthetic stock responses, HTTP response overrides, request/status counts, and configurable 429 throttling.
- `createFakeWordPressService`: fake Basic authentication, current-user capability responses, media lookups and upload responses, per-upload outcomes for partial failures, 401/403/429 responses, and a persist-then-disconnect window for retry verification.
- `createFakeCredentialCanary` and `scanCredentialCanary`: per-run fake credentials and a scanner that reports only matched categories/counts, never credential values.

The services intentionally keep no request body or header logs. WordPress media uploads accept the standard `Content-Disposition: attachment; filename=...` and UTF-8 `filename*` parameters, including safe basename handling for path-like names; the fixture-only `X-Fake-WP-Slug` header remains available for simpler cases. Snapshots expose fixed route names, counts, statuses, and synthetic media count only. Uploaded bytes are consumed in memory and are never written to disk. Media source URLs point back to the loopback fixture.

Run the service self-tests with:

```sh
node --test fixtures/e-v041-loopback/fake-services.test.mjs
```

These tests validate the fixture behavior. They do not exercise a SiteIndex product API, packaged IPC, a live WordPress account, upload permissions on a real site, or an external inventory service. Product-dependent acceptance remains pending until the relevant API is merged and the package is available.
