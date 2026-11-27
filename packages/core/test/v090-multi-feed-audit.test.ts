import { afterEach, expect, it, vi } from "vitest";
import { readFeeds, toSnapshot } from "../src/crawl/gmc-feed";

afterEach(() => vi.unstubAllGlobals());

it.fails("keeps a later valid duplicate SKU when an earlier feed item has no price", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const price = url.pathname === "/valid.xml" ? "<price>19.99 USD</price>" : "";
    return new Response(`<rss><channel><item><id>DEMO-1</id><link>https://shop.example.test/p/demo</link>${price}</item></channel></rss>`);
  }));
  const site = { base_url: "https://shop.example.test", currency: "USD",
    crawl: { feed_url: ["https://shop.example.test/invalid.xml", "https://shop.example.test/valid.xml"] } };
  const items = await readFeeds(site);
  const snapshot = toSnapshot(items, site, "2026-11-27");
  expect(snapshot.rows.map((row) => row.sku)).toEqual(["DEMO-1"]);
  expect(snapshot.rows[0]?.price).toBe(19.99);
});
