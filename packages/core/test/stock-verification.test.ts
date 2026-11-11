import { afterEach, describe, expect, it } from "vitest";
import { pathsFor, type ProjectLayout } from "@siteindex/shared";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readFeeds,
  readJsonl,
  runDaily,
  toSnapshot,
  writeJsonl,
  type FeedSiteConfig,
} from "../src";
import { verifyMissingStock } from "../src/jobs/stock-verifier";
import {
  createFakeGraphqlService,
  type FakeGraphqlService,
} from "../../../fixtures/e-v041-loopback/fake-services.mjs";
import {
  createFakeSiteService,
  type FakeSiteService,
} from "../../../fixtures/e-v041-loopback/fake-site-service.mjs";

interface TestSite extends FeedSiteConfig {
  domain: string;
  crawl: NonNullable<FeedSiteConfig["crawl"]> & {
    rate_limit_ms: number;
    missing_as: "removed" | "out_of_stock";
    max_removed_ratio: number;
    stock_verify: { enabled: boolean; graphql_url: string; max_per_run: number };
    stock_rules: { in_stock: string[]; out_of_stock: string[]; preorder: string[] };
  };
}

const tempDirs: string[] = [];
const siteServices: FakeSiteService[] = [];
const graphqlServices: FakeGraphqlService[] = [];
const fixtureRoot = path.resolve("fixtures", "stock-verification");
const runDate = "2026-10-22";
const runNow = new Date("2026-10-22T12:00:00Z");

afterEach(async () => {
  await Promise.all(siteServices.splice(0).map((service) => service.close()));
  await Promise.all(graphqlServices.splice(0).map((service) => service.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createSiteService(options: Parameters<typeof createFakeSiteService>[0] = {}): Promise<FakeSiteService> {
  return createFakeSiteService(options).then((service) => {
    siteServices.push(service);
    return service;
  });
}

function createGraphqlService(options: Parameters<typeof createFakeGraphqlService>[0] = {}): Promise<FakeGraphqlService> {
  return createFakeGraphqlService(options).then((service) => {
    graphqlServices.push(service);
    return service;
  });
}

async function newProject(
  siteService: FakeSiteService,
  graphqlService: FakeGraphqlService,
  layout: ProjectLayout = "legacy",
  maxPerRun = 50,
): Promise<{ root: string; site: TestSite }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-stock-verify-"));
  tempDirs.push(root);
  const paths = pathsFor(layout);
  await mkdir(path.join(root, paths.index), { recursive: true });
  const site: TestSite = {
    domain: "shop.example.test",
    base_url: siteService.origin,
    timezone: "UTC",
    crawl: {
      feed_url: siteService.feedUrl,
      missing_as: "removed",
      max_removed_ratio: 1,
      rate_limit_ms: 0,
      stock_verify: { enabled: true, graphql_url: graphqlService.endpoint, max_per_run: maxPerRun },
      stock_rules: { in_stock: ["in stock"], out_of_stock: ["sold out", "out of stock"], preorder: ["preorder", "pre-order"] },
    },
  };
  await writeFile(path.join(root, paths.site), `${JSON.stringify(site, null, 2)}\n`, "utf8");
  return { root, site };
}

function catalogRow(sku: string, siteService: FakeSiteService): Record<string, unknown> {
  return {
    sku,
    product_id: `PRODUCT-${sku}`,
    handle: sku.toLowerCase(),
    title: `Demo ${sku}`,
    variant_title: null,
    url: siteService.productUrl(sku),
    category: "demo",
    categories: ["demo"],
    category_source: "feed",
    price: 10,
    compare_at_price: null,
    currency: "USD",
    image_url: null,
    status: "active",
    first_seen: "2026-10-20",
    last_seen: "2026-10-21",
    updated_at: "2026-10-21",
  };
}

async function seed(
  root: string,
  siteService: FakeSiteService,
  rows: readonly { sku: string; status: "in_stock" | "out_of_stock" | "preorder" | "unknown" }[],
  layout: ProjectLayout,
): Promise<void> {
  const paths = pathsFor(layout);
  await writeJsonl(path.join(root, paths.skus), rows.map(({ sku }) => catalogRow(sku, siteService)), "sku");
  await writeJsonl(path.join(root, paths.inventoryLatest), rows.map(({ sku, status }) => ({
    sku,
    stock_status: status,
    qty: status === "in_stock" ? 3 : null,
    since: "2026-10-21",
    checked_at: "2026-10-21T12:00:00Z",
  })), "inventory_latest");
}

async function loadSnapshot(site: TestSite) {
  return toSnapshot(await readFeeds(site), site, runDate).rows;
}

async function runProjectDaily(root: string, site: TestSite) {
  return runDaily(root, await loadSnapshot(site), { date: runDate, now: runNow });
}

describe("feed-absence stock verification", () => {
  it("checks only absent active SKUs and aggregates GraphQL results in both layouts", async () => {
    const siteService = await createSiteService({
      feedRows: [{ sku: "DEMO-PRESENT", availability: "out of stock" }],
      defaultProductResponse: { status: 200, body: "<html><body>Demo product.</body></html>" },
    });
    const graphqlService = await createGraphqlService({ responsesBySku: {
      "DEMO-ANOMALY": { body: { data: { products: { items: [{ sku: "DEMO-ANOMALY", stock_status: "IN_STOCK" }] } } } },
      "DEMO-OOS": { body: { data: { products: { items: [{ sku: "DEMO-OOS", stock_status: "OUT_OF_STOCK" }] } } } },
      "DEMO-PREORDER": { body: { data: { products: { items: [{ sku: "DEMO-PREORDER", stock_status: "PREORDER" }] } } } },
    } });

    for (const layout of ["legacy", "workspace"] as const) {
      const { root, site } = await newProject(siteService, graphqlService, layout);
      await seed(root, siteService, [
        { sku: "DEMO-PRESENT", status: "out_of_stock" },
        { sku: "DEMO-ANOMALY", status: "out_of_stock" },
        { sku: "DEMO-OOS", status: "in_stock" },
        { sku: "DEMO-PREORDER", status: "in_stock" },
      ], layout);

      const siteBefore = siteService.snapshot().routeCounts;
      const graphqlBefore = graphqlService.snapshot().routeCounts;
      const result = await runProjectDaily(root, site);
      const paths = pathsFor(layout);
      const skus = await readJsonl(path.join(root, paths.skus));
      const latest = new Map((await readJsonl(path.join(root, paths.inventoryLatest))).map((row) => [String(row.sku), row]));
      const events = await readJsonl(path.join(root, paths.eventsDir, "2026-10.jsonl"));
      const siteRequests = siteService.snapshot().routeCounts;
      const graphqlRequests = graphqlService.snapshot().routeCounts;

      expect(result.status).toBe("ok");
      expect(result.counts.stock_verified).toBe(3);
      expect((siteRequests["GET /feed.csv"] ?? 0) - (siteBefore["GET /feed.csv"] ?? 0)).toBe(1);
      expect((siteRequests["GET /products/:sku"] ?? 0) - (siteBefore["GET /products/:sku"] ?? 0)).toBe(3);
      expect((graphqlRequests["POST /graphql"] ?? 0) - (graphqlBefore["POST /graphql"] ?? 0)).toBe(3);
      expect(skus.find((row) => row.sku === "DEMO-ANOMALY")).toMatchObject({ status: "active" });
      expect(latest.get("DEMO-ANOMALY")).toMatchObject({ stock_status: "in_stock", qty: null });
      expect(latest.get("DEMO-OOS")).toMatchObject({ stock_status: "out_of_stock", qty: null });
      expect(latest.get("DEMO-PREORDER")).toMatchObject({ stock_status: "preorder", qty: null });
      expect(result.counts.feed_anomaly).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ sku: "DEMO-ANOMALY", type: "feed_anomaly", from: "feed_absent", to: "in_stock" }));
      expect(events).toContainEqual(expect.objectContaining({ sku: "DEMO-ANOMALY", type: "stock_change", to: "in_stock" }));
      expect(skus.find((row) => row.sku === "DEMO-ANOMALY")?.removed_reason).toBeUndefined();
      expect(siteService.boundHost).toBe("127.0.0.1");
      expect(graphqlService.boundHost).toBe("127.0.0.1");
    }
  });

  it("uses page text after GraphQL failure, marks 404/410 removed, and preserves state on page 5xx", async () => {
    const oosHtml = await readFile(path.join(fixtureRoot, "out-of-stock.html"), "utf8");
    const inStockHtml = await readFile(path.join(fixtureRoot, "in-stock.html"), "utf8");
    const preorderHtml = await readFile(path.join(fixtureRoot, "preorder.html"), "utf8");
    const siteService = await createSiteService({
      feedRows: [{ sku: "DEMO-PRESENT" }],
      productResponsesBySku: {
        "DEMO-404": { status: 404 },
        "DEMO-410": { status: 410 },
        "DEMO-5XX": { status: 503 },
        "DEMO-TEXT-IN-STOCK": { body: inStockHtml },
        "DEMO-TEXT-OOS": { body: oosHtml },
        "DEMO-TEXT-PREORDER": { body: preorderHtml },
        "DEMO-UNKNOWN": { status: 200, body: "<html><body>Availability is not stated.</body></html>" },
      },
    });
    const graphqlService = await createGraphqlService({
      responsesBySku: { "DEMO-UNKNOWN": { body: { data: { products: { items: [{ sku: "DEMO-UNKNOWN", stock_status: "UNKNOWN" }] } } } } },
      defaultResponse: { httpStatus: 503, body: { errors: [{ message: "synthetic failure" }] } },
    });
    const { root, site } = await newProject(siteService, graphqlService);
    await seed(root, siteService, [
      { sku: "DEMO-PRESENT", status: "in_stock" },
      { sku: "DEMO-404", status: "in_stock" },
      { sku: "DEMO-410", status: "in_stock" },
      { sku: "DEMO-5XX", status: "in_stock" },
      { sku: "DEMO-TEXT-IN-STOCK", status: "out_of_stock" },
      { sku: "DEMO-TEXT-OOS", status: "in_stock" },
      { sku: "DEMO-TEXT-PREORDER", status: "in_stock" },
      { sku: "DEMO-UNKNOWN", status: "in_stock" },
    ], "legacy");
    const result = await runProjectDaily(root, site);
    const paths = pathsFor("legacy");
    const catalog = new Map((await readJsonl(path.join(root, paths.skus))).map((row) => [String(row.sku), row]));
    const latest = new Map((await readJsonl(path.join(root, paths.inventoryLatest))).map((row) => [String(row.sku), row]));

    expect(result.status).toBe("partial");
    expect(result.counts.stock_verify_unavailable).toBe(1);
    expect(catalog.get("DEMO-404")).toMatchObject({ status: "removed", removed_reason: "feed_absent_404" });
    expect(catalog.get("DEMO-410")).toMatchObject({ status: "removed", removed_reason: "feed_absent_404" });
    expect(catalog.get("DEMO-UNKNOWN")).toMatchObject({ status: "removed" });
    expect(catalog.get("DEMO-UNKNOWN")?.removed_reason).toBeUndefined();
    expect(catalog.get("DEMO-TEXT-OOS")).toMatchObject({ status: "active" });
    expect(latest.get("DEMO-TEXT-OOS")).toMatchObject({ stock_status: "out_of_stock" });
    expect(latest.get("DEMO-TEXT-IN-STOCK")).toMatchObject({ stock_status: "in_stock" });
    expect(latest.get("DEMO-TEXT-PREORDER")).toMatchObject({ stock_status: "preorder" });
    expect((await readJsonl(path.join(root, paths.eventsDir, "2026-10.jsonl"))).some((row) => row.type === "feed_anomaly" && row.sku === "DEMO-TEXT-IN-STOCK")).toBe(true);
    expect(catalog.get("DEMO-5XX")).toMatchObject({ status: "active" });
    expect(latest.get("DEMO-5XX")).toMatchObject({ stock_status: "in_stock", checked_at: "2026-10-21T12:00:00Z" });
    expect(graphqlService.snapshot().routeCounts["POST /graphql"]).toBe(4);
  });

  it("does not request product or GraphQL pages for an empty feed or tripped removal-ratio guard", async () => {
    const siteService = await createSiteService();
    const graphqlService = await createGraphqlService();
    const { root, site } = await newProject(siteService, graphqlService);
    await seed(root, siteService, [
      { sku: "DEMO-A", status: "in_stock" },
      { sku: "DEMO-B", status: "in_stock" },
      { sku: "DEMO-KEEP", status: "in_stock" },
    ], "legacy");
    const paths = pathsFor("legacy");
    const beforeSkus = await readFile(path.join(root, paths.skus), "utf8");
    const beforeLatest = await readFile(path.join(root, paths.inventoryLatest), "utf8");

    const empty = await runProjectDaily(root, site);
    siteService.setFeedRows([{ sku: "DEMO-KEEP" }]);
    const sitePath = path.join(root, paths.site);
    const updatedSite = { ...site, crawl: { ...site.crawl, max_removed_ratio: 0.1 } };
    await writeFile(sitePath, `${JSON.stringify(updatedSite, null, 2)}\n`, "utf8");
    const guarded = await runProjectDaily(root, updatedSite);

    expect(empty.status).toBe("failed");
    expect(guarded.exitCode).toBe(3);
    expect(siteService.snapshot().routeCounts["GET /feed.csv"]).toBe(2);
    expect(siteService.snapshot().routeCounts["GET /products/:sku"] ?? 0).toBe(0);
    expect(graphqlService.snapshot().routeCounts["POST /graphql"] ?? 0).toBe(0);
    expect(await readFile(path.join(root, paths.skus), "utf8")).toBe(beforeSkus);
    expect(await readFile(path.join(root, paths.inventoryLatest), "utf8")).toBe(beforeLatest);
  });

  it("falls back to configured page text when the GraphQL request times out", async () => {
    const siteService = await createSiteService({
      productResponsesBySku: { "DEMO-GQL-TIMEOUT": { status: 200, body: "<main>In stock</main>" } },
    });
    const graphqlService = await createGraphqlService({ defaultResponse: { delayMs: 100 } });
    const { site } = await newProject(siteService, graphqlService);
    const requestedMethods: string[] = [];
    const result = await verifyMissingStock(
      [{ sku: "DEMO-GQL-TIMEOUT", url: siteService.productUrl("DEMO-GQL-TIMEOUT") }],
      site,
      {
        timeoutMs: 10,
        async fetcher(input, init) {
          requestedMethods.push(init?.method ?? "GET");
          if (init?.method === "POST") throw new Error("Synthetic GraphQL timeout");
          return fetch(input, init);
        },
      },
    );

    expect(result.results.get("DEMO-GQL-TIMEOUT")).toEqual({ kind: "status", status: "in_stock" });
    expect(result.unavailable).toBe(0);
    expect(siteService.snapshot().routeCounts["GET /products/:sku"]).toBe(1);
    expect(requestedMethods).toEqual(["GET", "POST"]);
    expect(graphqlService.snapshot().totalRequests).toBe(0);
  });

  it("enforces max_per_run and waits between serial requests", async () => {
    const requests: string[] = [];
    const waits: number[] = [];
    const result = await verifyMissingStock([
      { sku: "DEMO-B", url: "http://127.0.0.1:4567/products/DEMO-B" },
      { sku: "DEMO-A", url: "http://127.0.0.1:4567/products/DEMO-A" },
    ], {
      base_url: "http://127.0.0.1:4567",
      crawl: { rate_limit_ms: 25, stock_verify: { enabled: true, graphql_url: "http://127.0.0.1:4568/graphql", max_per_run: 1 } },
    }, {
      async wait(milliseconds) { waits.push(milliseconds); },
      async fetcher(input, init) {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (url.pathname === "/graphql") {
          const body: unknown = JSON.parse(String(init?.body));
          const variables = typeof body === "object" && body !== null && "variables" in body && typeof body.variables === "object" && body.variables !== null
            ? body.variables : {};
          const sku = typeof variables === "object" && variables !== null && "sku" in variables ? String(variables.sku) : "";
          return new Response(JSON.stringify({ data: { products: { items: [{ sku, stock_status: "IN_STOCK" }] } } }), { status: 200 });
        }
        return new Response("<main>Demo product page.</main>", { status: 200 });
      },
    });

    expect(result.checked).toBe(1);
    expect(result.deferred).toBe(1);
    expect(result.results.get("DEMO-A")).toEqual({ kind: "status", status: "in_stock" });
    expect(result.results.has("DEMO-B")).toBe(false);
    expect(requests).toEqual(["GET /products/DEMO-A", "POST /graphql"]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it("preserves state on timeout and rejects non-loopback HTTP and cross-origin product URLs", async () => {
    const siteService = await createSiteService({
      productResponsesBySku: { "DEMO-TIMEOUT": { timeout: true } },
    });
    const graphqlService = await createGraphqlService();
    const project = await newProject(siteService, graphqlService);
    const timeout = await verifyMissingStock([{ sku: "DEMO-TIMEOUT", url: siteService.productUrl("DEMO-TIMEOUT") }], project.site, { timeoutMs: 10 });
    expect(timeout.results.get("DEMO-TIMEOUT")).toEqual({ kind: "unavailable" });
    expect(timeout.unavailable).toBe(1);
    expect(graphqlService.snapshot().totalRequests).toBe(0);

    const requests: string[] = [];
    const unsafeHttp = await verifyMissingStock([{ sku: "DEMO-HTTP", url: "http://shop.example.test/product" }], {
      base_url: "http://shop.example.test",
      crawl: { stock_verify: { enabled: true, graphql_url: "https://shop.example.test/graphql" } },
    }, { fetcher: async (input) => { requests.push(String(input)); return new Response("", { status: 200 }); } });
    const crossOriginProduct = await verifyMissingStock([{ sku: "DEMO-FOREIGN", url: "http://example.test/product" }], {
      base_url: siteService.origin,
      crawl: { stock_verify: { enabled: true, graphql_url: graphqlService.endpoint } },
    }, { fetcher: async (input) => { requests.push(String(input)); return new Response("", { status: 200 }); } });
    const nonLoopbackGraphql = await verifyMissingStock([{ sku: "DEMO-HTTP-GRAPHQL", url: "https://shop.example.test/product" }], {
      base_url: "https://shop.example.test",
      crawl: { stock_verify: { enabled: true, graphql_url: "http://shop.example.test/graphql" } },
    }, { fetcher: async (input) => { requests.push(String(input)); return new Response("", { status: 200 }); } });

    expect(unsafeHttp.unavailable).toBe(1);
    expect(crossOriginProduct.results.get("DEMO-FOREIGN")).toEqual({ kind: "unavailable" });
    expect(nonLoopbackGraphql.unavailable).toBe(1);
    expect(requests).toEqual([]);
    expect(siteService.boundHost).toBe("127.0.0.1");
  });
});
