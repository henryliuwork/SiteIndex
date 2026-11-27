import { describe, expect, it } from "vitest";
import { verifyProductDiscoveryRoutes } from "../scripts/acceptance/product-discovery-routes.mjs";

const fixtureRoot = new URL("../../../fixtures/woocommerce-v065/", import.meta.url);

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
});
