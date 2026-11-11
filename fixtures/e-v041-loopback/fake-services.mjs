import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_GRAPHQL_BODY = { data: { product: { stock_status: "IN_STOCK" } } };
const WP_USER_ROUTE = "GET /wp-json/wp/v2/users/me";
const WP_MEDIA_ROUTE = "GET /wp-json/wp/v2/media";
const WP_MEDIA_POST_ROUTE = "POST /wp-json/wp/v2/media";
const WP_MEDIA_UPDATE_ROUTE = "POST /wp-json/wp/v2/media/:id";

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function makeRecorder() {
  const routeCounts = Object.create(null);
  const statusCounts = Object.create(null);
  const outcomeCounts = Object.create(null);
  let totalRequests = 0;

  return {
    record(route, status, outcome = "response") {
      totalRequests += 1;
      increment(routeCounts, route);
      increment(statusCounts, String(status));
      increment(outcomeCounts, outcome);
    },
    snapshot(boundHost, origin, additional = {}) {
      return {
        boundHost,
        origin,
        totalRequests,
        routeCounts: { ...routeCounts },
        statusCounts: { ...statusCounts },
        outcomeCounts: { ...outcomeCounts },
        ...additional,
      };
    },
  };
}

async function readRequestBody(request, maximumBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      const error = new Error("Fake service request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendWpError(response, status) {
  const code = status === 401
    ? "rest_not_logged_in"
    : status === 403
      ? "rest_forbidden"
      : status === 429
        ? "rest_rate_limited"
        : "rest_upload_failed";
  const message = status === 401
    ? "Synthetic authentication rejected."
    : status === 403
      ? "Synthetic user does not have upload permission."
      : status === 429
        ? "Synthetic service rate limit."
        : "Synthetic upload failed.";
  sendJson(response, status, { code, message, data: { status } });
}

function startLoopbackServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (response.destroyed || response.writableEnded) return;
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(response, status, { error: "synthetic_service_error" });
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Loopback test server did not bind to an IP address"));
        return;
      }
      const origin = "http://" + LOOPBACK_HOST + ":" + address.port;
      let closed = false;
      resolve({
        server,
        origin,
        boundHost: LOOPBACK_HOST,
        async close() {
          if (closed) return;
          closed = true;
          const closePromise = new Promise((closeResolve, closeReject) => {
            server.close((error) => error ? closeReject(error) : closeResolve());
          });
          server.closeAllConnections?.();
          await closePromise;
        },
      });
    });
  });
}

function getRoute(method, pathname) {
  if (method === "POST" && pathname === "/graphql") return "POST /graphql";
  if (method === "GET" && pathname === "/wp-json/wp/v2/users/me") return WP_USER_ROUTE;
  if (method === "GET" && pathname === "/wp-json/wp/v2/media") return WP_MEDIA_ROUTE;
  if (method === "POST" && pathname === "/wp-json/wp/v2/media") return WP_MEDIA_POST_ROUTE;
  if (method === "POST" && /^\/wp-json\/wp\/v2\/media\/\d+$/u.test(pathname)) return WP_MEDIA_UPDATE_ROUTE;
  return "OTHER";
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function createFakeGraphqlService({
  responsesBySku = {},
  rateLimitAfter = Number.POSITIVE_INFINITY,
  defaultResponse = { httpStatus: 200, body: DEFAULT_GRAPHQL_BODY },
} = {}) {
  const recorder = makeRecorder();
  const graphqlServer = await startLoopbackServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://" + LOOPBACK_HOST).pathname;
    const route = getRoute(request.method ?? "GET", pathname);
    if (route !== "POST /graphql") {
      recorder.record("OTHER", 404);
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const requestBytes = await readRequestBody(request);
    let payload;
    try {
      payload = JSON.parse(requestBytes.toString("utf8"));
    } catch {
      recorder.record(route, 400, "invalid_json");
      sendJson(response, 400, { errors: [{ message: "Synthetic GraphQL request must be JSON." }] });
      return;
    }

    const requestNumber = recorder.snapshot(LOOPBACK_HOST, graphqlServer.origin).routeCounts[route] ?? 0;
    if (requestNumber >= rateLimitAfter) {
      recorder.record(route, 429, "rate_limited");
      sendJson(response, 429, { errors: [{ message: "Synthetic GraphQL rate limit." }] });
      return;
    }

    const sku = payload?.variables?.sku;
    const configured = typeof sku === "string" ? responsesBySku[sku] : undefined;
    const result = configured ?? defaultResponse;
    const delayMs = Math.max(0, Number(result?.delayMs) || 0);
    if (delayMs > 0) await wait(delayMs);
    const status = Number.isInteger(result?.httpStatus) ? result.httpStatus : 200;
    recorder.record(route, status);
    sendJson(response, status, result?.body ?? DEFAULT_GRAPHQL_BODY);
  });

  return {
    origin: graphqlServer.origin,
    endpoint: graphqlServer.origin + "/graphql",
    boundHost: graphqlServer.boundHost,
    snapshot: () => recorder.snapshot(graphqlServer.boundHost, graphqlServer.origin, {
      requestBodiesRecorded: false,
      requestHeadersRecorded: false,
    }),
    close: () => graphqlServer.close(),
  };
}

function safeBasename(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed percent escapes remain subject to the slug character allowlist below.
  }
  return decoded
    .replace(/\\/gu, "/")
    .split("/")
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/gu, "") ?? "";
}

function normalizeSlug(value) {
  const filename = safeBasename(value);
  if (!filename) return null;
  const base = filename.replace(/\.[^.]+$/u, "");
  const slug = base.toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120)
    .replace(/-+$/u, "");
  return slug || null;
}

const IMAGE_EXTENSION_BY_CONTENT_TYPE = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

function mediaExtension(filename, contentType) {
  const basename = safeBasename(filename) ?? "";
  const extension = /\.([a-z0-9]{1,10})$/iu.exec(basename)?.[1];
  if (extension) return extension.toLowerCase();
  const mimeType = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  return IMAGE_EXTENSION_BY_CONTENT_TYPE[mimeType] ?? "jpg";
}

function decodeExtendedFilename(value) {
  const match = /^([^']*)'[^']*'(.*)$/u.exec(value);
  if (!match || !["utf-8", "us-ascii"].includes(match[1].toLowerCase())) return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

function contentDispositionFilename(header) {
  if (typeof header !== "string") return null;

  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/iu.exec(header);
  if (extended) return decodeExtendedFilename((extended[1] ?? extended[2] ?? "").trim());

  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/iu.exec(header);
  if (!plain) return null;
  return (plain[1] ?? plain[2] ?? "").replace(/\\(["\\])/gu, "$1").trim();
}

function extractMediaFilename(request, url, body) {
  const headerSlug = request.headers["x-fake-wp-slug"];
  if (typeof headerSlug === "string") return headerSlug;
  const querySlug = url.searchParams.get("slug");
  if (querySlug) return querySlug;

  const dispositionFilename = contentDispositionFilename(request.headers["content-disposition"]);
  if (dispositionFilename) return dispositionFilename;

  const contentType = request.headers["content-type"] ?? "";
  if (String(contentType).includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      const jsonSlug = payload?.slug ?? payload?.filename;
      if (typeof jsonSlug === "string") return jsonSlug;
    } catch {
      return null;
    }
  }

  const filename = body.toString("latin1").match(/filename="([^"]+)"/iu)?.[1];
  return filename ?? null;
}

function uniqueMediaSlug(baseSlug, mediaBySlug) {
  if (!mediaBySlug.has(baseSlug)) return baseSlug;
  let suffix = 1;
  while (mediaBySlug.has(baseSlug + "-" + suffix)) suffix += 1;
  return baseSlug + "-" + suffix;
}

export async function createFakeWordPressService({
  credentials,
  currentUserStatus = 200,
  mediaGetStatus = 200,
  mediaPostStatus = 201,
  mediaMetaStatus = 200,
  mediaPostStatuses,
  persistMediaBeforePostFailure = false,
  mediaSourcePath = "/wp-content/uploads",
  onMediaPersist,
  uploadFilesCapability = true,
  rateLimitAfter = Number.POSITIVE_INFINITY,
  disconnectAfterPersist = 0,
} = {}) {
  const recorder = makeRecorder();
  const mediaBySlug = new Map();
  let nextMediaId = 7000;
  let mediaPostAttempts = 0;
  let disconnectsRemaining = Math.max(0, Number(disconnectAfterPersist) || 0);
  let wordPressServer;

  const expectedAuthorization = credentials
    ? "Basic " + Buffer.from(credentials.username + ":" + credentials.applicationPassword).toString("base64")
    : null;

  wordPressServer = await startLoopbackServer(async (request, response) => {
    const url = new URL(request.url ?? "/", wordPressServer.origin);
    const route = getRoute(request.method ?? "GET", url.pathname);
    const body = request.method === "POST" ? await readRequestBody(request) : Buffer.alloc(0);

    if (route === "OTHER") {
      recorder.record(route, 404);
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const requestNumber = recorder.snapshot(LOOPBACK_HOST, wordPressServer.origin).totalRequests;
    if (requestNumber >= rateLimitAfter) {
      recorder.record(route, 429, "rate_limited");
      sendWpError(response, 429);
      return;
    }

    if (expectedAuthorization === null || request.headers.authorization !== expectedAuthorization) {
      recorder.record(route, 401, "auth_rejected");
      sendWpError(response, 401);
      return;
    }

    if (route === WP_USER_ROUTE) {
      const status = currentUserStatus;
      recorder.record(route, status);
      if (status !== 200) {
        sendWpError(response, status);
        return;
      }
      sendJson(response, 200, {
        id: 1,
        name: "Synthetic Uploader",
        capabilities: { upload_files: uploadFilesCapability },
      });
      return;
    }

    if (route === WP_MEDIA_ROUTE) {
      const status = mediaGetStatus;
      recorder.record(route, status);
      if (status !== 200) {
        sendWpError(response, status);
        return;
      }
      const slug = normalizeSlug(url.searchParams.get("slug"));
      const item = slug ? mediaBySlug.get(slug) : undefined;
      sendJson(response, 200, item ? [item] : []);
      return;
    }

    if (route === WP_MEDIA_UPDATE_ROUTE) {
      recorder.record(route, mediaMetaStatus);
      if (mediaMetaStatus !== 200) {
        sendWpError(response, mediaMetaStatus);
        return;
      }
      const mediaId = Number(url.pathname.split("/").at(-1));
      const media = [...mediaBySlug.values()].find((item) => item.id === mediaId);
      if (!media) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      let metadata = {};
      try { metadata = JSON.parse(body.toString("utf8")); }
      catch { sendJson(response, 400, { error: "invalid_metadata" }); return; }
      media.title = typeof metadata.title === "string" ? metadata.title : "";
      media.alt_text = typeof metadata.alt_text === "string" ? metadata.alt_text : "";
      sendJson(response, 200, media);
      return;
    }

    const forcedPostStatus = Array.isArray(mediaPostStatuses)
      ? (mediaPostStatuses[mediaPostAttempts] ?? mediaPostStatus)
      : mediaPostStatus;
    mediaPostAttempts += 1;
    if (!uploadFilesCapability) {
      recorder.record(route, 403);
      sendWpError(response, 403);
      return;
    }

    const persistMedia = async () => {
      const mediaFilename = extractMediaFilename(request, url, body);
      const slug = normalizeSlug(mediaFilename);
      if (!slug) return null;
      const storedSlug = uniqueMediaSlug(slug, mediaBySlug);
      const extension = mediaExtension(mediaFilename, request.headers["content-type"]);
      const safePath = String(mediaSourcePath).replace(/\\/gu, "/").replace(/\/+$/u, "");
      const media = {
        id: nextMediaId,
        slug: storedSlug,
        source_url: wordPressServer.origin + safePath + "/" + storedSlug + "." + extension,
      };
      nextMediaId += 1;
      mediaBySlug.set(storedSlug, media);
      await onMediaPersist?.({ ...media, body: Buffer.from(body) });
      return media;
    };

    if (forcedPostStatus !== 201) {
      const persisted = persistMediaBeforePostFailure ? await persistMedia() : null;
      if (persistMediaBeforePostFailure && !persisted) {
        recorder.record(route, 400, "missing_synthetic_slug");
        sendJson(response, 400, { code: "rest_upload_no_data", message: "Synthetic media slug is required." });
        return;
      }
      recorder.record(route, forcedPostStatus, persisted ? "persisted_then_error" : "response");
      if (forcedPostStatus >= 300 && forcedPostStatus < 400) {
        response.writeHead(forcedPostStatus, { location: "/wp-json/wp/v2/media/redirect-target" });
        response.end();
      } else {
        sendWpError(response, forcedPostStatus);
      }
      return;
    }

    const media = await persistMedia();
    if (!media) {
      recorder.record(route, 400, "missing_synthetic_slug");
      sendJson(response, 400, { code: "rest_upload_no_data", message: "Synthetic media slug is required." });
      return;
    }

    if (disconnectsRemaining > 0) {
      disconnectsRemaining -= 1;
      recorder.record(route, "disconnect", "persisted_then_disconnected");
      response.destroy();
      return;
    }

    recorder.record(route, 201, "persisted");
    sendJson(response, 201, media);
  });

  return {
    origin: wordPressServer.origin,
    boundHost: wordPressServer.boundHost,
    currentUserEndpoint: wordPressServer.origin + "/wp-json/wp/v2/users/me",
    mediaEndpoint: wordPressServer.origin + "/wp-json/wp/v2/media",
    snapshot: () => recorder.snapshot(wordPressServer.boundHost, wordPressServer.origin, {
      mediaCount: mediaBySlug.size,
      requestBodiesRecorded: false,
      requestHeadersRecorded: false,
    }),
    close: () => wordPressServer.close(),
  };
}

export function createFakeCredentialCanary() {
  const username = "fixture-user-" + randomUUID();
  const applicationPassword = "fixture-secret-" + randomUUID();
  const basicToken = Buffer.from(username + ":" + applicationPassword).toString("base64");
  return {
    username,
    applicationPassword,
    basicToken,
    authorization: "Basic " + basicToken,
  };
}

export function scanCredentialCanary(value, credentials) {
  let serialized;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  serialized ??= String(value);

  const candidates = [
    ["username", credentials?.username],
    ["applicationPassword", credentials?.applicationPassword],
    ["usernameAndPassword", credentials?.username && credentials?.applicationPassword
      ? credentials.username + ":" + credentials.applicationPassword
      : null],
    ["basicToken", credentials?.basicToken],
    ["authorizationHeader", credentials?.authorization],
  ];
  const matchedKinds = candidates
    .filter(([, token]) => typeof token === "string" && token.length > 0 && serialized.includes(token))
    .map(([kind]) => kind);
  return {
    passed: matchedKinds.length === 0,
    matchCount: matchedKinds.length,
    matchedKinds,
  };
}
