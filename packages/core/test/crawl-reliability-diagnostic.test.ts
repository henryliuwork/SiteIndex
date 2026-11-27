import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXIT, PATHS, type CreateProjectInput, type DetectResult, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFiles } from "../src/projects/create";
import { createCoreService } from "../src/service";
import { readJsonl, writeJsonl } from "../src/io/jsonl";
import { writeRunner } from "../src/io/runner-lock";

const SITE = "https://catalog.example.test";
const roots: string[] = [];
const servers: Server[] = [];

interface RouteResponse {
  body: string;
  status?: number;
  contentType?: string;
}

interface Loopback {
  set(pathname: string, response: RouteResponse): void;
  close(): Promise<void>;
}

async function startLoopback(): Promise<Loopback> {
  const routes = new Map<string, RouteResponse>();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "catalog.example.test"}`).pathname;
    const route = routes.get(pathname) ?? { body: "not found", status: 404, contentType: "text/plain" };
    response.writeHead(route.status ?? 200, { "content-type": route.contentType ?? "application/xml; charset=utf-8" });
    response.end(route.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  const localBase = `http://127.0.0.1:${address.port}`;
  const networkFetch = globalThis.fetch;
  const routeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.hostname.endsWith(".example.test")) throw new Error(`Unexpected non-synthetic request host: ${url.hostname}`);
    const target = new URL(`${url.pathname}${url.search}`, localBase);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("host", url.host);
    return networkFetch(target, { ...init, headers });
  };
  vi.stubGlobal("fetch", routeFetch);
  return {
    set: (pathname, route) => routes.set(pathname, route),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function feedItem(input: {
  id: string;
  slug?: string;
  title?: string;
  price?: string;
  link?: string;
  itemGroupId?: string;
  color?: string;
  customSku?: string;
}): string {
  const tag = (name: string, value: string | undefined) => value === undefined ? "" : `<g:${name}>${value}</g:${name}>`;
  const link = input.link === "" ? undefined : input.link ?? `${SITE}/products/${input.slug ?? input.id.toLowerCase()}`;
  return `<item>${tag("id", input.id)}${tag("title", input.title ?? input.id)}${tag("link", link)}`
    + `${tag("price", input.price ?? "12.00 USD")}${tag("availability", "in stock")}`
    + `${tag("item_group_id", input.itemGroupId)}${tag("color", input.color)}`
    + `${input.customSku === undefined ? "" : `<merchant_sku>${input.customSku}</merchant_sku>`}</item>`;
}

function feedXml(...items: Parameters<typeof feedItem>[0][]): string {
  return `<rss xmlns:g="urn:siteindex:synthetic"><channel>${items.map(feedItem).join("")}</channel></rss>`;
}

function sitemapXml(urls: readonly string[]): string {
  return `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
}

function productPage(sku: string): string {
  const data = { "@type": "Product", sku, name: `Demo ${sku}`,
    offers: { price: "12.00", priceCurrency: "USD", availability: "InStock" } };
  return `<html><head><title>Demo ${sku}</title><script type="application/ld+json">${JSON.stringify(data)}</script></head>`
    + `<body><main><h1>Demo ${sku}</h1><p>Synthetic product page for diagnostic testing.</p></main></body></html>`;
}

async function makeProject(options: {
  feedUrls?: string[];
  skuField?: string;
  maxPages?: number;
  skuGrouping?: SiteConfig["sku_grouping"];
} = {}): Promise<{ projectPath: string; config: SiteConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-crawl-diag-"));
  roots.push(root);
  const input: CreateProjectInput = {
    url: SITE,
    feed_urls: options.feedUrls ?? [`${SITE}/feed.xml`],
    sku_field: options.skuField ?? "id",
    category_depth: 1,
    missing_as: "out_of_stock",
    brand: { name: "Synthetic Catalog" },
    markets: ["US"],
    projects_root: root,
    folder_name: "diagnostic-project",
    workspace_folders: [],
  };
  const detected: DetectResult = {
    input: SITE, final_url: `${SITE}/`, redirect_status: null,
    robots: { found: true, disallow_count: 0, sitemaps: [`${SITE}/sitemap.xml`] },
    sitemaps: [], total_urls: 0, platform: "other", platform_evidence: "synthetic loopback fixture",
    frontend: null, locale: "en-US", currency: "USD", feed_candidates: [],
  };
  const created = await createProjectFiles(input, detected);
  const config = created.config;
  config.sitemaps = [`${SITE}/sitemap.xml`];
  config.crawl.rate_limit_ms = 200;
  config.crawl.max_removed_ratio = 0.1;
  config.crawl.max_pages = options.maxPages ?? 100;
  if (options.skuGrouping) config.sku_grouping = options.skuGrouping;
  await writeFile(path.join(created.path, PATHS.site), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { projectPath: created.path, config };
}

function serviceFor(projectPath: string) {
  return createCoreService({ resolveProject: () => projectPath, deviceId: "synthetic-device",
    deviceName: "Synthetic Test Device", cacheDir: path.join(path.dirname(projectPath), "cache") });
}

async function runPages(projectPath: string, date = "2026-11-27") {
  return serviceFor(projectPath).runJob({ projectPath, job: "weekly", only: "pages", trigger: "manual", date }, () => undefined);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v0.9.0 A-1 synthetic crawl diagnostic C1–C11", () => {
  it("C1: daily feed SKU and the same sitemap product both reach Core product views", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject();
    const sku = "DEMO-C1-NEW";
    loopback.set("/feed.xml", { body: feedXml({ id: sku, slug: "demo-c1" }) });
    loopback.set("/sitemap.xml", { body: sitemapXml([`${SITE}/products/demo-c1`]) });
    loopback.set("/products/demo-c1", { body: productPage(sku), contentType: "text/html; charset=utf-8" });

    const api = serviceFor(projectPath);
    const daily = await api.runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined);
    expect(daily.status).toBe("ok");
    expect((await readJsonl(path.join(projectPath, PATHS.skus))).map((row) => row.sku)).toContain(sku);
    const products = await api.products.list("diagnostic", { page: 1, pageSize: 0 });
    const edm = await api.edm.listImages("diagnostic", { page: 1, pageSize: 0 });
    expect(products.rows.some((row) => row.skus.includes(sku))).toBe(true);
    expect(edm.rows.some((row) => row.sku === sku)).toBe(true);

    const weekly = await runPages(projectPath);
    expect(weekly.counts?.pages).toBe(1);
    expect((await readJsonl(path.join(projectPath, PATHS.seoPages))).some((row) => row.url === `${SITE}/products/demo-c1`)).toBe(true);
  }, 30_000);

  it("C2: a valid sitemap-only product enters the product catalog after P7 approval", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject({ feedUrls: [] });
    const sku = "DEMO-C2-SITEMAP-ONLY";
    loopback.set("/sitemap.xml", { body: sitemapXml([`${SITE}/products/demo-c2`]) });
    loopback.set("/products/demo-c2", { body: productPage(sku), contentType: "text/html; charset=utf-8" });

    await runPages(projectPath);
    const products = await serviceFor(projectPath).products.list("diagnostic", { page: 1, pageSize: 0 });
    expect(products.rows.some((row) => row.skus.includes(sku))).toBe(true);
  });

  // Expected failures document diagnostics gaps without changing crawler behavior in this phase.

  it.each([
    { label: "C3 missing id", item: { id: "" }, reason: "无 SKU", drop: "dropped_no_id" },
    { label: "C3 missing price", item: { id: "DEMO-C3-NO-PRICE", price: "" }, reason: "缺价格", drop: "dropped_missing_price_or_link" },
    { label: "C4 missing link", item: { id: "DEMO-C4-NO-LINK", link: "" }, reason: "缺链接", drop: "dropped_missing_price_or_link" },
  ])("$label: returns a readable reason and feed drop counts", async ({ item, reason, drop }) => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject();
    loopback.set("/feed.xml", { body: feedXml(item) });
    const daily = await serviceFor(projectPath).runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined);
    expect(daily.status).toBe("failed");
    expect(daily.errors?.join(" ")).toContain(reason);
    expect(daily.counts).toMatchObject({ feed_items: 1, written: 0, new_sku: 0, [drop]: 1 });
    const run = (await readJsonl(path.join(projectPath, PATHS.runs))).find((row) => row.job === "daily");
    expect(run?.counts).toMatchObject({ feed_items: 1, written: 0, [drop]: 1 });
  });

  it("C5: honors configured SKU field and falls back to feed id when that field is absent", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject({ skuField: "merchant_sku" });
    loopback.set("/feed.xml", { body: feedXml(
      { id: "DEMO-C5-ID", customSku: "DEMO-C5-CONFIGURED", slug: "custom" },
      { id: "DEMO-C5-FALLBACK", slug: "fallback" },
    ) });
    const daily = await serviceFor(projectPath).runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined);
    expect(daily.status).toBe("ok");
    expect((await readJsonl(path.join(projectPath, PATHS.skus))).map((row) => row.sku).sort())
      .toEqual(["DEMO-C5-CONFIGURED", "DEMO-C5-FALLBACK"]);
  });

  it("C6: merges multiple feed files in order, deduplicates id, and reports every feed count", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject({ feedUrls: [`${SITE}/feed-first.xml`, `${SITE}/feed-second.xml`] });
    loopback.set("/feed-first.xml", { body: feedXml({ id: "DEMO-C6-DUP", title: "First feed", slug: "same" }) });
    loopback.set("/feed-second.xml", { body: feedXml(
      { id: "DEMO-C6-DUP", title: "Second feed", slug: "same" },
      { id: "DEMO-C6-UNIQUE", slug: "unique" },
    ) });
    const daily = await serviceFor(projectPath).runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined);
    const rows = await readJsonl(path.join(projectPath, PATHS.skus));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.sku === "DEMO-C6-DUP")?.title).toBe("First feed");
    expect(daily.counts).toMatchObject({
      feed_items: 3, written: 2, new_sku: 0,
      dropped_no_id: 0, dropped_duplicate: 1, dropped_missing_price_or_link: 0,
    });
    const run = (await readJsonl(path.join(projectPath, PATHS.runs))).find((row) => row.job === "daily");
    expect(run?.counts).toMatchObject({ feed_items: 3, written: 2, dropped_duplicate: 1 });
  });

  it("C7: prioritizes the newest sitemap lastmod and reports max_pages truncation", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject({ feedUrls: [], maxPages: 2 });
    const pages = [
      { pathname: "/products/oldest", lastmod: "2026-01-01" },
      { pathname: "/products/middle", lastmod: "2026-02-01" },
      { pathname: "/products/newest", lastmod: "2026-03-01" },
    ];
    loopback.set("/sitemap.xml", { body: `<urlset>${pages.map(({ pathname, lastmod }) =>
      `<url><loc>${SITE}${pathname}</loc><lastmod>${lastmod}</lastmod></url>`).join("")}</urlset>` });
    for (const [index, { pathname }] of pages.entries()) {
      loopback.set(pathname, { body: productPage(`DEMO-C7-${index + 1}`), contentType: "text/html; charset=utf-8" });
    }
    const weekly = await runPages(projectPath);
    expect({ status: weekly.status, counts: weekly.counts }).toMatchObject({
      status: "partial", counts: { sitemap_urls: 3, crawled: 2, truncated: 1 },
    });
    expect(weekly.errors?.join(" ")).toMatch(/max_pages|跳过/iu);
    const rows = await readJsonl(path.join(projectPath, PATHS.seoPages));
    expect(rows.map((row) => String(row.url)).sort()).toEqual([`${SITE}/products/middle`, `${SITE}/products/newest`].sort());
    const run = (await readJsonl(path.join(projectPath, PATHS.runs))).find((row) => row.job === "weekly");
    expect(run?.counts).toMatchObject({ sitemap_urls: 3, crawled: 2, truncated: 1 });
  });

  it("keeps original order for equally undated sitemap URLs after dated URLs", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject({ feedUrls: [], maxPages: 2 });
    const pages = [
      { pathname: "/products/dated", lastmod: "2026-03-01" },
      { pathname: "/products/no-date-first" },
      { pathname: "/products/no-date-second" },
    ];
    loopback.set("/sitemap.xml", { body: `<urlset>${pages.map(({ pathname, lastmod }) =>
      `<url><loc>${SITE}${pathname}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>` });
    for (const [index, { pathname }] of pages.entries()) {
      loopback.set(pathname, { body: productPage(`DEMO-C7-STABLE-${index + 1}`), contentType: "text/html; charset=utf-8" });
    }

    const weekly = await runPages(projectPath);
    const rows = await readJsonl(path.join(projectPath, PATHS.seoPages));

    expect(weekly.status).toBe("partial");
    expect(rows.map((row) => String(row.url)).sort()).toEqual([
      `${SITE}/products/dated`, `${SITE}/products/no-date-first`,
    ].sort());
  });

  it("C8: a new item_group_id variant remains in the SKU catalog and product variant list", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject();
    const feedPath = "/feed.xml";
    const variantA = { id: "DEMO-C8-A", title: "Demo group red", itemGroupId: "DEMO-C8-GROUP", color: "Red", slug: "group" };
    const variantB = { id: "DEMO-C8-B", title: "Demo group blue", itemGroupId: "DEMO-C8-GROUP", color: "Blue", slug: "group" };
    loopback.set(feedPath, { body: feedXml(variantA) });
    const api = serviceFor(projectPath);
    expect((await api.runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-26" }, () => undefined)).status).toBe("ok");
    loopback.set(feedPath, { body: feedXml(variantA, variantB) });
    expect((await api.runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined)).status).toBe("ok");
    const skus = await readJsonl(path.join(projectPath, PATHS.skus));
    const products = await api.products.list("diagnostic", { page: 1, pageSize: 0 });
    expect(skus.map((row) => row.sku).sort()).toEqual(["DEMO-C8-A", "DEMO-C8-B"]);
    expect(skus.every((row) => row.product_id === "DEMO-C8-GROUP")).toBe(true);
    expect(products.rows).toHaveLength(1);
    expect(products.rows[0]?.skus).toEqual(["DEMO-C8-A", "DEMO-C8-B"]);
  });

  it("C9: a new feed SKU matching the grouping rule appears as a child, not as a phantom stock SKU", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject({ skuGrouping: { enabled: true, rule: { type: "suffix", value: "-VAR" } } });
    loopback.set("/feed.xml", { body: feedXml({ id: "DEMO-C9-PARENT-VAR", slug: "parent" }) });
    const result = await serviceFor(projectPath).runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    const skus = await readJsonl(path.join(projectPath, PATHS.skus));
    const stock = await readJsonl(path.join(projectPath, PATHS.skuStockView));
    expect(skus.map((row) => row.sku)).toEqual(["DEMO-C9-PARENT-VAR"]);
    expect(stock).toMatchObject([{ sku: "DEMO-C9-PARENT-VAR", parent_sku: "DEMO-C9-PARENT" }]);
    expect(stock.some((row) => row.sku === "DEMO-C9-PARENT")).toBe(false);
  });

  it("C10: removal-ratio protection fails closed without changing catalog bytes", async () => {
    const loopback = await startLoopback();
    const { projectPath } = await makeProject();
    const skuPath = path.join(projectPath, PATHS.skus);
    const previous = ["DEMO-C10-KEEP", "DEMO-C10-OLD-A", "DEMO-C10-OLD-B"].map((sku) => ({
      sku, product_id: sku, handle: sku.toLowerCase(), title: sku, variant_title: null, url: `${SITE}/products/${sku}`,
      category: "synthetic", categories: ["synthetic"], price: 12, compare_at_price: null, currency: "USD",
      image_url: null, status: "active", first_seen: "2026-11-26", last_seen: "2026-11-26", updated_at: "2026-11-26",
    }));
    await writeJsonl(skuPath, previous, "sku");
    const before = await readFile(skuPath);
    loopback.set("/feed.xml", { body: feedXml({ id: "DEMO-C10-KEEP" }) });
    const result = await serviceFor(projectPath).runJob({ projectPath, job: "daily", trigger: "manual", date: "2026-11-27" }, () => undefined);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(EXIT.GUARD_ABORTED);
    expect(await readFile(skuPath)).toEqual(before);
  });

  it("C11: manual and registered scheduled daily runs both process the same synthetic feed", async () => {
    const loopback = await startLoopback();
    loopback.set("/feed.xml", { body: feedXml({ id: "DEMO-C11-SHARED", slug: "shared" }) });
    const manualProject = await makeProject();
    const scheduledProject = await makeProject();
    const manual = await serviceFor(manualProject.projectPath).runJob({
      projectPath: manualProject.projectPath, job: "daily", trigger: "manual", date: "2026-11-26",
    }, () => undefined);
    await writeRunner(scheduledProject.projectPath, {
      device_id: "synthetic-device", device_name: "Synthetic Test Device", claimed_at: "2026-11-26T00:00:00Z",
    });
    const scheduled = await serviceFor(scheduledProject.projectPath).runJob({
      projectPath: scheduledProject.projectPath, job: "daily", trigger: "schedule", date: "2026-11-27",
    }, () => undefined);
    expect(manual.status).toBe("ok");
    expect(scheduled.status).toBe("ok");
    expect((await readJsonl(path.join(manualProject.projectPath, PATHS.skus))).map((row) => row.sku)).toEqual(["DEMO-C11-SHARED"]);
    expect((await readJsonl(path.join(scheduledProject.projectPath, PATHS.skus))).map((row) => row.sku)).toEqual(["DEMO-C11-SHARED"]);
  });
});
