# v0.4.1 loopback service fixtures

These reusable HTTP fixtures support E's synthetic acceptance preparation. They use fictional payloads and bind only to `127.0.0.1` on an ephemeral port; they do not call a real GraphQL endpoint, WordPress site, or other external service. HTTP is limited to this test-only loopback fixture and does not change the production HTTPS requirement.

`fake-services.mjs` exports:

- `createFakeGraphqlService`: synthetic stock responses, HTTP response overrides, request/status counts, and configurable 429 throttling.
- `createFakeWordPressService`: fake Basic authentication, current-user capability responses, media lookups and upload responses, per-upload outcomes for partial failures, 401/403/429 responses, and a persist-then-disconnect window for retry verification.
- `createFakeCredentialCanary` and `scanCredentialCanary`: per-run fake credentials and a scanner that reports only matched categories/counts, never credential values.

`fake-site-service.mjs` exports `createFakeSiteService` for synthetic GMC CSV feeds and product pages. It can return 200 text, 404/410, 5xx, delayed or held-open responses, and route-level request counts; it binds only to loopback and does not record request paths or content.

The services intentionally keep no request body or header logs. WordPress media uploads accept the standard `Content-Disposition: attachment; filename=...` and UTF-8 `filename*` parameters, including safe basename handling for path-like names. Synthetic media URLs preserve a safe filename extension, falling back to a supported image Content-Type when needed. The fixture-only `X-Fake-WP-Slug` header remains available for simpler cases. Snapshots expose fixed route names, counts, statuses, and synthetic media count only. Uploaded bytes are consumed in memory and are never written to disk. Media source URLs point back to the loopback fixture.

Run the service self-tests with:

```sh
node --test fixtures/e-v041-loopback/fake-services.test.mjs
```

These tests validate the fixtures. The feed service is shaped for Core's existing CSV reader, but no stock-verifier API is present on the current main; protection-threshold, GraphQL-fallback, feed-anomaly, and CLI integration remain pending A's implementation. The fixtures do not exercise packaged IPC or any real site/account. Product-dependent package acceptance remains pending until A/C connect the relevant interfaces.

Current-main and branch evidence are separated in `v041-acceptance-matrix.md`. The stock-verifier scenarios reference the open PR #417 head and are not main or package acceptance. The K5 media contract remains pending Core and Desktop implementation.
