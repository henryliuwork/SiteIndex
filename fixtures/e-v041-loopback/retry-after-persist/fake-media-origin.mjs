import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const MEDIA_ROUTE = "/wp-json/wp/v2/media";
const PERSISTED_FAILURES = new Map([
  ["persist_then_422", 422],
  ["persist_then_429", 429],
  ["persist_then_500", 500],
]);
const MODES = new Set(["persist_then_201", "persist_then_disconnect", ...PERSISTED_FAILURES.keys()]);

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function discardBody(request) {
  for await (const _chunk of request) {
    // Read the synthetic upload to complete the HTTP exchange; never retain it.
  }
}

function uniqueSlug(base, mediaBySlug) {
  if (!mediaBySlug.has(base)) return base;
  let suffix = 1;
  while (mediaBySlug.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export async function createRetryWordPressService({ credentials, firstPostMode } = {}) {
  if (!credentials?.username || !credentials?.applicationPassword) {
    throw new TypeError("Synthetic WordPress credentials are required.");
  }
  if (!MODES.has(firstPostMode)) {
    throw new TypeError("A supported synthetic first-post outcome is required.");
  }

  const expectedAuthorization = "Basic " + Buffer.from(
    `${credentials.username}:${credentials.applicationPassword}`,
  ).toString("base64");
  const mediaBySlug = new Map();
  const routeCounts = Object.create(null);
  const statusCounts = Object.create(null);
  const outcomeCounts = Object.create(null);
  let nextMediaId = 9400;
  let postAttempts = 0;
  let origin;

  const record = (route, status, outcome) => {
    routeCounts[route] = (routeCounts[route] ?? 0) + 1;
    const statusKey = String(status);
    statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    const route = method === "GET" && url.pathname === MEDIA_ROUTE
      ? `GET ${MEDIA_ROUTE}`
      : method === "POST" && url.pathname === MEDIA_ROUTE
        ? `POST ${MEDIA_ROUTE}`
        : "OTHER";

    if (method === "POST") await discardBody(request);

    if (route === "OTHER") {
      record(route, 404, "not_found");
      sendJson(response, 404, { code: "rest_no_route", message: "Synthetic route not found." });
      return;
    }

    if (request.headers.authorization !== expectedAuthorization) {
      record(route, 401, "auth_rejected");
      sendJson(response, 401, { code: "rest_not_logged_in", message: "Synthetic authentication rejected." });
      return;
    }

    if (route === `GET ${MEDIA_ROUTE}`) {
      const slug = url.searchParams.get("slug");
      const item = typeof slug === "string" ? mediaBySlug.get(slug) : undefined;
      record(route, 200, item ? "lookup_hit" : "lookup_miss");
      sendJson(response, 200, item ? [item] : []);
      return;
    }

    postAttempts += 1;
    const requestedSlug = request.headers["x-fake-wp-slug"];
    if (typeof requestedSlug !== "string" || !/^synthetic-[a-z0-9-]{1,64}$/u.test(requestedSlug)) {
      record(route, 400, "invalid_synthetic_slug");
      sendJson(response, 400, { code: "rest_upload_no_data", message: "Synthetic media slug is required." });
      return;
    }

    const slug = uniqueSlug(requestedSlug, mediaBySlug);
    const media = {
      id: nextMediaId++,
      slug,
      source_url: `${origin}/wp-content/uploads/${slug}.jpg`,
    };
    mediaBySlug.set(slug, media);

    if (postAttempts === 1 && PERSISTED_FAILURES.has(firstPostMode)) {
      const status = PERSISTED_FAILURES.get(firstPostMode);
      const outcome = status === 429 ? "persisted_then_rate_limited" : `persisted_then_http_${status}`;
      const code = status === 429 ? "rest_rate_limited" : "rest_upload_failed";
      record(route, status, outcome);
      sendJson(response, status, {
        code,
        message: `Synthetic HTTP ${status} after persistence.`,
      }, status === 429 ? { "retry-after": "0" } : {});
      return;
    }

    if (postAttempts === 1 && firstPostMode === "persist_then_disconnect") {
      record(route, "disconnect", "persisted_then_disconnected");
      response.destroy();
      return;
    }

    record(route, 201, "persisted");
    sendJson(response, 201, media);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Loopback fixture did not receive a TCP address.");
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;

  return {
    boundHost: LOOPBACK_HOST,
    origin,
    mediaEndpoint: `${origin}${MEDIA_ROUTE}`,
    snapshot() {
      return {
        boundHost: LOOPBACK_HOST,
        totalRequests: Object.values(routeCounts).reduce((sum, count) => sum + count, 0),
        routeCounts: { ...routeCounts },
        statusCounts: { ...statusCounts },
        outcomeCounts: { ...outcomeCounts },
        postAttempts,
        mediaCount: mediaBySlug.size,
        requestBodiesRecorded: false,
        requestHeadersRecorded: false,
      };
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
