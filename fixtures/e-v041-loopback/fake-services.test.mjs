import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  createFakeCredentialCanary,
  createFakeGraphqlService,
  createFakeWordPressService,
  scanCredentialCanary,
} from "./fake-services.mjs";

const openServices = new Set();

after(async () => {
  await Promise.all([...openServices].map((service) => service.close()));
  openServices.clear();
});

async function track(servicePromise) {
  const service = await servicePromise;
  openServices.add(service);
  const close = service.close;
  service.close = async () => {
    openServices.delete(service);
    await close();
  };
  return service;
}

function authHeaders(credentials) {
  return { authorization: credentials.authorization };
}

describe("v0.4.1 loopback synthetic services", () => {
  it("binds GraphQL to loopback, counts requests, returns fixture data, then rate-limits", async () => {
    const service = await track(createFakeGraphqlService({
      rateLimitAfter: 1,
      responsesBySku: {
        "SYNTHETIC-SKU-01": {
          body: { data: { product: { stock_status: "OUT_OF_STOCK" } } },
        },
      },
    }));
    assert.equal(service.boundHost, "127.0.0.1");

    const request = () => fetch(service.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query SyntheticStock($sku: String!) { product(sku: $sku) { stock_status } }", variables: { sku: "SYNTHETIC-SKU-01" } }),
    });
    const first = await request();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { data: { product: { stock_status: "OUT_OF_STOCK" } } });

    const second = await request();
    assert.equal(second.status, 429);
    assert.equal((await second.json()).errors[0].message, "Synthetic GraphQL rate limit.");

    const snapshot = service.snapshot();
    assert.equal(snapshot.totalRequests, 2);
    assert.equal(snapshot.routeCounts["POST /graphql"], 2);
    assert.equal(snapshot.statusCounts["200"], 1);
    assert.equal(snapshot.statusCounts["429"], 1);
    assert.equal(snapshot.outcomeCounts.rate_limited, 1);
    assert.equal(snapshot.requestBodiesRecorded, false);
    assert.equal(snapshot.requestHeadersRecorded, false);
    assert.equal(JSON.stringify(snapshot).includes("SYNTHETIC-SKU-01"), false);
  });

  it("models WordPress 401, upload permission 403, and request counts without retaining credentials", async () => {
    const credentials = createFakeCredentialCanary();
    const service = await track(createFakeWordPressService({
      credentials,
      uploadFilesCapability: false,
    }));
    assert.equal(service.boundHost, "127.0.0.1");

    const unauthorized = await fetch(service.currentUserEndpoint, {
      headers: { authorization: "Basic invalid-synthetic-token" },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).code, "rest_not_logged_in");

    const currentUser = await fetch(service.currentUserEndpoint, { headers: authHeaders(credentials) });
    assert.equal(currentUser.status, 200);
    assert.equal((await currentUser.json()).capabilities.upload_files, false);

    const forbidden = await fetch(service.mediaEndpoint, {
      method: "POST",
      headers: {
        ...authHeaders(credentials),
        "content-type": "image/jpeg",
        "x-fake-wp-slug": "synthetic-image-01",
      },
      body: Buffer.from("synthetic image bytes"),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, "rest_forbidden");

    const snapshot = service.snapshot();
    assert.equal(snapshot.totalRequests, 3);
    assert.equal(snapshot.routeCounts["GET /wp-json/wp/v2/users/me"], 2);
    assert.equal(snapshot.routeCounts["POST /wp-json/wp/v2/media"], 1);
    assert.equal(snapshot.statusCounts["401"], 1);
    assert.equal(snapshot.statusCounts["403"], 1);
    assert.equal(snapshot.requestBodiesRecorded, false);
    assert.equal(snapshot.requestHeadersRecorded, false);
    assert.equal(scanCredentialCanary({ snapshot, error: { code: "rest_forbidden" } }, credentials).passed, true);
  });

  it("persists a synthetic upload before disconnect so a client can verify before retrying", async () => {
    const credentials = createFakeCredentialCanary();
    const service = await track(createFakeWordPressService({
      credentials,
      disconnectAfterPersist: 1,
    }));
    assert.equal(service.boundHost, "127.0.0.1");

    await assert.rejects(fetch(service.mediaEndpoint, {
      method: "POST",
      headers: {
        ...authHeaders(credentials),
        "content-type": "image/jpeg",
        "content-disposition": 'attachment; filename="../synthetic-image-02.jpg"',
      },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    }));

    const lookup = await fetch(service.mediaEndpoint + "?slug=synthetic-image-02", {
      headers: authHeaders(credentials),
    });
    assert.equal(lookup.status, 200);
    const matches = await lookup.json();
    assert.equal(matches.length, 1);
    assert.equal(matches[0].slug, "synthetic-image-02");
    assert.match(matches[0].source_url, /^http:\/\/127\.0\.0\.1:\d+\/wp-content\/uploads\//u);

    const snapshot = service.snapshot();
    assert.equal(snapshot.totalRequests, 2);
    assert.equal(snapshot.routeCounts["POST /wp-json/wp/v2/media"], 1);
    assert.equal(snapshot.routeCounts["GET /wp-json/wp/v2/media"], 1);
    assert.equal(snapshot.outcomeCounts.persisted_then_disconnected, 1);
    assert.equal(snapshot.mediaCount, 1);
    assert.equal(JSON.stringify(snapshot).includes("synthetic-image-02"), false);
    assert.equal(JSON.stringify(snapshot).includes("content-disposition"), false);
    assert.equal(scanCredentialCanary({ snapshot, matches }, credentials).passed, true);
  });

  it("returns per-upload outcomes so a mixed success and permission failure stays inspectable", async () => {
    const credentials = createFakeCredentialCanary();
    const service = await track(createFakeWordPressService({
      credentials,
      mediaPostStatuses: [201, 403],
    }));
    const upload = (slug) => fetch(service.mediaEndpoint, {
      method: "POST",
      headers: {
        ...authHeaders(credentials),
        "content-type": "image/jpeg",
        "x-fake-wp-slug": slug,
      },
      body: Buffer.from("synthetic image bytes"),
    });

    const accepted = await upload("synthetic-success-01");
    assert.equal(accepted.status, 201);
    const denied = await upload("synthetic-denied-02");
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "rest_forbidden");

    const snapshot = service.snapshot();
    assert.equal(snapshot.totalRequests, 2);
    assert.equal(snapshot.routeCounts["POST /wp-json/wp/v2/media"], 2);
    assert.equal(snapshot.statusCounts["201"], 1);
    assert.equal(snapshot.statusCounts["403"], 1);
    assert.equal(snapshot.mediaCount, 1);
  });

  it("decodes filename-star safely and reduces encoded path traversal to a basename", async () => {
    const credentials = createFakeCredentialCanary();
    const service = await track(createFakeWordPressService({ credentials }));
    const upload = await fetch(service.mediaEndpoint, {
      method: "POST",
      headers: {
        ...authHeaders(credentials),
        "content-type": "image/png",
        "content-disposition": "attachment; filename*=UTF-8''%2E%2E%2Fsynthetic%20file-03.png",
      },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    assert.equal(upload.status, 201);
    assert.equal((await upload.json()).slug, "synthetic-file-03");

    const lookup = await fetch(service.mediaEndpoint + "?slug=synthetic-file-03", {
      headers: authHeaders(credentials),
    });
    assert.equal((await lookup.json()).length, 1);
    assert.equal(service.snapshot().mediaCount, 1);
  });

  it("detects fake credential canaries but returns only categories and counts", () => {
    const credentials = createFakeCredentialCanary();
    const unsafeSample = {
      username: credentials.username,
      password: credentials.applicationPassword,
      combined: credentials.username + ":" + credentials.applicationPassword,
      basicToken: credentials.basicToken,
      authorization: credentials.authorization,
    };
    const finding = scanCredentialCanary(unsafeSample, credentials);
    const report = JSON.stringify(finding);

    assert.equal(finding.passed, false);
    assert.equal(finding.matchCount, 5);
    assert.deepEqual(finding.matchedKinds, [
      "username",
      "applicationPassword",
      "usernameAndPassword",
      "basicToken",
      "authorizationHeader",
    ]);
    for (const secret of [credentials.username, credentials.applicationPassword, credentials.basicToken, credentials.authorization]) {
      assert.equal(report.includes(secret), false);
    }
  });

  it("applies a configured WordPress rate limit after the allowed request", async () => {
    const credentials = createFakeCredentialCanary();
    const service = await track(createFakeWordPressService({ credentials, rateLimitAfter: 1 }));
    const request = () => fetch(service.currentUserEndpoint, { headers: authHeaders(credentials) });

    assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "rest_rate_limited");
    assert.equal(service.snapshot().totalRequests, 2);
    assert.equal(service.snapshot().statusCounts["429"], 1);
  });
});
