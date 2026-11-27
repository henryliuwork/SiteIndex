import { afterEach, expect, it, vi } from "vitest";
import { FeedError, parseFeed, readFeeds, toSnapshot, type FeedSiteConfig } from "../src/crawl/gmc-feed";

const site: FeedSiteConfig = { base_url: "https://shop.example.test", currency: "USD", crawl: {} };
afterEach(() => vi.unstubAllGlobals());

it("preserves zero and thousand-separated prices and maps uncommon availability values", () => {
  const entries = [
    ["ZERO", "0 USD", "in stock"],
    ["COMMA", "1,234.56 USD", "backorder"],
    ["DOT", "1.234,56 EUR", "preorder"],
    ["UNKNOWN", "10 USD", "unexpected"],
  ];
  const xml = `<rss><channel>${entries.map(([sku, price, availability]) =>
    `<item><id>${sku}</id><link>https://shop.example.test/p/${sku}</link><price>${price}</price><availability>${availability}</availability></item>`
  ).join("")}</channel></rss>`;
  const { rows } = toSnapshot(parseFeed(xml), site, "2026-11-27");
  expect(rows.map(({ sku, price, currency, stock_status }) => ({ sku, price, currency, stock_status }))).toEqual([
    { sku: "ZERO", price: 0, currency: "USD", stock_status: "in_stock" },
    { sku: "COMMA", price: 1234.56, currency: "USD", stock_status: "preorder" },
    { sku: "DOT", price: 1234.56, currency: "EUR", stock_status: "preorder" },
    { sku: "UNKNOWN", price: 10, currency: "USD", stock_status: "unknown" },
  ]);
});

it("rejects an HTTP error instead of treating its response as a feed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("service unavailable", { status: 503 })));
  await expect(readFeeds({ ...site, crawl: { feed_url: "https://shop.example.test/feed.xml" } }))
    .rejects.toMatchObject({ code: "FEED_FETCH_FAILED" } satisfies Partial<FeedError>);
});
