import { readFile } from "node:fs/promises";

export const PRODUCT_DISCOVERY_ROUTES = Object.freeze({
  feed: "/merchant/products.xml",
  sitemap: "/product-sitemap.xml",
  sitemapOnlyPage: "/product/sample-kit/",
  sitemapOnlySku: "DEMO-WC-KIT",
  feedSku: "DEMO-WC-LAMP",
});

// Validate the checked-in synthetic route split before an installed-app run.
// A missing route is a harness error; product discovery assertions happen later in the adapter.
export async function verifyProductDiscoveryRoutes(fixtureRoot) {
  const routes = JSON.parse(await readFile(new URL("routes.json", fixtureRoot), "utf8"));
  const body = async (route) => {
    const match = routes.find((entry) => entry.method === "GET" && entry.path === route);
    if (!match) throw new Error(`Synthetic route is missing: ${route}`);
    return readFile(new URL(match.body, fixtureRoot), "utf8");
  };
  const [feed, sitemap, product] = await Promise.all([
    body(PRODUCT_DISCOVERY_ROUTES.feed), body(PRODUCT_DISCOVERY_ROUTES.sitemap),
    body(PRODUCT_DISCOVERY_ROUTES.sitemapOnlyPage),
  ]);
  if (!feed.includes(PRODUCT_DISCOVERY_ROUTES.feedSku) || feed.includes(PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku)
    || !sitemap.includes(PRODUCT_DISCOVERY_ROUTES.sitemapOnlyPage)
    || !product.includes(PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku) || !/"price":"25\.00"/u.test(product)) {
    throw new Error("Synthetic feed and sitemap do not isolate a priced new product");
  }
  return PRODUCT_DISCOVERY_ROUTES;
}
