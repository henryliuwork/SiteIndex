import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductDiscoveryFixture, ipcCatalog, productDiscoveryAdapter } from "../scripts/acceptance/product-discovery-adapter.mjs";
import { verifyProductDiscoveryRoutes } from "../scripts/acceptance/product-discovery-routes.mjs";

const fixtureRoot = new URL("../../../fixtures/woocommerce-v065/", import.meta.url);
afterEach(() => vi.unstubAllGlobals());

describe("v0.9.0 packaged product discovery route plan", () => {
  it("has a priced sitemap-only product outside the synthetic GMC Feed", async () => {
    await expect(verifyProductDiscoveryRoutes(fixtureRoot)).resolves.toMatchObject({
      feed: "/merchant/products.xml", sitemap: "/product-sitemap.xml",
      sitemapOnlySku: "DEMO-WC-KIT", sitemapOnlyPage: "/product/sample-kit/",
    });
  });

  it("fails closed if the route source is unavailable", async () => {
    await expect(verifyProductDiscoveryRoutes(new URL("./missing-fixtures/", import.meta.url)))
      .rejects.toThrow();
  });

  it("creates a synthetic Feed plus Sitemap project without active system schedules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-discovery-"));
    try {
      const fixture = await createProductDiscoveryFixture({ layout: { projectRoot: root } },
        "http://127.0.0.1:43001", "synthetic-device");
      const site = JSON.parse(await readFile(path.join(fixture.indexDir, "site.json"), "utf8"));
      expect(site.crawl.feed_url).toEqual(["http://127.0.0.1:43001/merchant/products.xml"]);
      expect(site.sitemaps).toEqual(["http://127.0.0.1:43001/product-sitemap.xml"]);
      expect(site.crawl.auto_collect_products).toBe(false);
      expect(site.schedule.weekly.enabled).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies a missing candidate product as an assertion failure", async () => {
    const page = { evaluate: async () => ({ productSkus: ["DEMO-WC-LAMP"], stock: [] }) };
    await expect(productDiscoveryAdapter().verifyCandidateIpc({ page, noteIpc: () => undefined }))
      .rejects.toMatchObject({ acceptanceStatus: "assertion_failed" });
  });

  it("reads packaged IPC page results through their rows arrays", async () => {
    vi.stubGlobal("window", { siteindex: {
      products: { list: async () => ({ rows: [{ skus: ["DEMO-WC-KIT"] }], total: 1 }) },
      inventory: { listSkus: async () => ({ rows: [{ sku: "DEMO-WC-KIT", stock_status: "unknown" }], total: 1 }) },
    } });
    const page = { evaluate: (callback: (id: string) => unknown, id: string) => callback(id) };
    await expect(ipcCatalog(page)).resolves.toEqual({
      productSkus: ["DEMO-WC-KIT"], stock: [{ sku: "DEMO-WC-KIT", status: "unknown" }],
    });
  });
});
