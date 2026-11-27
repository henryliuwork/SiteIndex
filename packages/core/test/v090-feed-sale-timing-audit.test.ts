import { afterEach, expect, it, vi } from "vitest";
import { parseFeed, toSnapshot } from "../src/crawl/gmc-feed";

afterEach(() => vi.useRealTimers());

it.fails("does not apply a sale after its absolute end time even when the project local date is earlier", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-28T01:00:00Z"));
  const xml = `<rss><channel><item><id>DEMO-SALE</id><link>https://shop.example.test/p/demo-sale</link>
    <price>20 USD</price><sale_price>15 USD</sale_price>
    <sale_price_effective_date>2026-11-27T00:00:00Z/2026-11-27T23:59:00Z</sale_price_effective_date>
    </item></channel></rss>`;
  const snapshot = toSnapshot(parseFeed(xml), {
    base_url: "https://shop.example.test", currency: "USD", timezone: "America/Los_Angeles", crawl: {},
  });
  expect(snapshot.rows[0]).toMatchObject({ price: 20, compare_at_price: null });
});
