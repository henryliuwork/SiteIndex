import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const FEED_ROUTE = "GET /feed.csv";
const PRODUCT_ROUTE = "GET /products/:sku";
const OTHER_ROUTE = "OTHER";
const FEED_HEADERS = ["id", "title", "link", "price", "availability", "product_type"];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function makeSyntheticGmcFeedCsv(rows, productUrlForSku) {
  const lines = [FEED_HEADERS.join(",")];
  for (const row of rows) {
    const sku = String(row.sku ?? "");
    lines.push([
      sku,
      row.title ?? `Synthetic product ${sku}`,
      row.link ?? productUrlForSku(sku),
      row.price ?? "9.99 USD",
      row.availability ?? "in stock",
      row.product_type ?? "Synthetic > Fixtures",
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

function makeRecorder() {
  const routeCounts = Object.create(null);
  const statusCounts = Object.create(null);
  const outcomeCounts = Object.create(null);
  let totalRequests = 0;

  return {
    begin(route) {
      totalRequests += 1;
      routeCounts[route] = (routeCounts[route] ?? 0) + 1;
      let finished = false;
      return (status, outcome = "response") => {
        if (finished) return;
        finished = true;
        const statusKey = String(status);
        statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;
        outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
      };
    },
    snapshot() {
      return {
        boundHost: LOOPBACK_HOST,
        totalRequests,
        routeCounts: { ...routeCounts },
        statusCounts: { ...statusCounts },
        outcomeCounts: { ...outcomeCounts },
        requestBodiesRecorded: false,
        requestHeadersRecorded: false,
      };
    },
  };
}

function requestRoute(request, url) {
  if (request.method === "GET" && url.pathname === "/feed.csv") {
    return { route: FEED_ROUTE };
  }
  const product = request.method === "GET" ? /^\/products\/([^/]+)$/u.exec(url.pathname) : null;
  if (product) {
    let sku = product[1] ?? "";
    try { sku = decodeURIComponent(sku); } catch { /* malformed segment remains a synthetic lookup key */ }
    if (sku.endsWith(".html")) sku = sku.slice(0, -5);
    return { route: PRODUCT_ROUTE, sku };
  }
  return { route: OTHER_ROUTE };
}

function send(response, status, body, contentType, finish) {
  finish(status);
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(body);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseBody(response, fallbackBody) {
  return typeof response.body === "string" ? response.body : fallbackBody;
}

export async function createFakeSiteService({
  feedRows = [],
  feedResponse = {},
  productResponsesBySku = {},
  defaultProductResponse = { status: 404, body: "Synthetic product page not found." },
} = {}) {
  const recorder = makeRecorder();
  let currentFeedRows = [...feedRows];
  let siteServer;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://" + LOOPBACK_HOST);
    const { route, sku } = requestRoute(request, url);
    const finish = recorder.begin(route);
    response.once("close", () => {
      if (!response.writableEnded) finish("timeout", "client_timeout");
    });

    if (route === OTHER_ROUTE) {
      send(response, 404, "Synthetic route not found.", "text/plain; charset=utf-8", finish);
      return;
    }

    const configured = route === FEED_ROUTE
      ? feedResponse
      : productResponsesBySku[sku ?? ""] ?? defaultProductResponse;
    const status = Number.isInteger(configured.status) && configured.status >= 100 && configured.status <= 599
      ? configured.status
      : 200;
    const contentType = configured.contentType ?? (route === FEED_ROUTE ? "text/csv; charset=utf-8" : "text/html; charset=utf-8");
    const body = route === FEED_ROUTE
      ? responseBody(configured, makeSyntheticGmcFeedCsv(currentFeedRows, (value) => siteServer.origin + "/products/" + encodeURIComponent(value) + ".html"))
      : responseBody(configured, "<html><body>Synthetic product page.</body></html>");

    if (configured.timeout === true) return;
    const delayMs = Math.max(0, Math.min(30_000, Number(configured.delayMs) || 0));
    void (async () => {
      if (delayMs) await delay(delayMs);
      send(response, status, body, contentType, finish);
    })().catch(() => send(response, 500, "Synthetic fixture failure.", "text/plain; charset=utf-8", finish));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fake site service did not bind to an IP address"));
        return;
      }
      siteServer = { origin: "http://" + LOOPBACK_HOST + ":" + address.port };
      resolve();
    });
  });

  let closed = false;
  return {
    origin: siteServer.origin,
    boundHost: LOOPBACK_HOST,
    feedUrl: siteServer.origin + "/feed.csv",
    productUrl(sku) {
      return siteServer.origin + "/products/" + encodeURIComponent(String(sku)) + ".html";
    },
    setFeedRows(rows) {
      currentFeedRows = [...rows];
    },
    snapshot: () => recorder.snapshot(),
    async close() {
      if (closed) return;
      closed = true;
      const closePromise = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections?.();
      await closePromise;
    },
  };
}
