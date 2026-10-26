import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFeedOverrides, FeedError, parseFeed, readFeeds, toSnapshot, writeSnapshot, type FeedSiteConfig } from "../src";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GMC feed parser", () => {
  it.each(["day1.xml", "day2.xml", "day3.tsv", "day4.xml"])("matches the golden snapshot for %s", async (name) => {
    const fixtureDir = path.join(process.cwd(), "fixtures");
    const [source, siteText, expected] = await Promise.all([
      readFile(path.join(fixtureDir, "feeds", name)),
      readFile(path.join(fixtureDir, "inputs", "site.json"), "utf8"),
      readFile(path.join(fixtureDir, "expected", "snapshots", `${name.replace(/\.(xml|tsv)$/, "")}.jsonl`), "utf8"),
    ]);
    const site = JSON.parse(siteText) as FeedSiteConfig;
    const { rows } = toSnapshot(parseFeed(source), site, "2026-10-21");
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-feed-"));
    roots.push(root);
    const output = path.join(root, "snapshot.jsonl");
    await writeSnapshot(output, rows);
    expect(await readFile(output, "utf8")).toBe(expected);
  });

  it("normalizes whitespace and Google namespace prefixes in TSV headers", () => {
    const [item] = parseFeed(" g:id \tg:sale price\tavailability\r\nSKU-1\t10 USD\tbackorder\r\n");
    expect(item).toEqual({ id: "SKU-1", sale_price: "10 USD", availability: "backorder" });
  });

  it("uses the supplied date for sale price eligibility and maps nonstandard availability to unknown", () => {
    const site: FeedSiteConfig = {
      base_url: "https://example.com",
      currency: "USD",
      crawl: { category_depth: 1 },
    };
    const { rows } = toSnapshot(parseFeed(`
      <rss><channel>
        <item><g:id>SALE</g:id><g:title>Sale</g:title><g:link>https://example.com/p?utm_source=x&color=red</g:link><g:price>20.00 USD</g:price><g:sale_price>15.00 USD</g:sale_price><g:sale_price_effective_date>2020-01-01T00:00:00Z/2020-12-31T23:59:00Z</g:sale_price_effective_date><g:availability>mystery</g:availability></item>
      </channel></rss>`.replaceAll("&color", "&amp;color")), site, "2026-10-21");
    expect(rows[0]).toMatchObject({ price: 20, compare_at_price: null, stock_status: "unknown", url: "https://example.com/p?color=red" });
  });

  it("applies configured overrides by SKU after feed parsing", () => {
    const site: FeedSiteConfig = { base_url: "https://example.com", crawl: {} };
    const { rows } = toSnapshot(parseFeed('<rss><channel><item><id>SKU-1</id><link>https://example.com/a</link><price>10 USD</price></item></channel></rss>'), site, "2026-10-21");
    expect(applyFeedOverrides(rows, { "SKU-1": { title: "Manual title" } })[0]?.title).toBe("Manual title");
  });

  it("parses Magento Amasty XML gzip feeds", async () => {
    const xml = `<rss><channel><item><g:id>MAG-1</g:id><g:title>Magento item</g:title><g:link>https://shop.example/p/mag-1</g:link><g:price>19.95 USD</g:price><g:availability>in stock</g:availability><g:product_type>Garden &gt; Tools</g:product_type></item></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gzipSync(xml), { headers: { "content-type": "application/gzip" } })));

    await expect(readFeeds({ base_url: "https://shop.example", crawl: { feed_url: "https://shop.example/amasty-products.xml.gz" } }))
      .resolves.toEqual([{ id: "MAG-1", title: "Magento item", link: "https://shop.example/p/mag-1", price: "19.95 USD", availability: "in stock", product_type: "Garden > Tools" }]);
  });

  it("parses WooCommerce plugin feeds with repeated categories and image links", () => {
    const [item] = parseFeed(`<rss><channel><item><g:id>WC-1</g:id><g:title>Woo item</g:title><g:link>https://shop.example/p/wc-1</g:link><g:price>20.00 USD</g:price><g:product_type>Home</g:product_type><g:product_type>Outdoor</g:product_type><g:image_link>https://shop.example/main.jpg</g:image_link><g:additional_image_link>https://shop.example/one.jpg</g:additional_image_link><g:additional_image_link>https://shop.example/two.jpg</g:additional_image_link></item></channel></rss>`);
    expect(item).toMatchObject({
      id: "WC-1", product_type: "Home", product_type_all: ["Home", "Outdoor"],
      additional_image_link: "https://shop.example/one.jpg",
      additional_image_link_all: ["https://shop.example/one.jpg", "https://shop.example/two.jpg"],
    });
  });

  it("decodes CDATA and HTML entities", () => {
    const [item] = parseFeed(`<rss><channel><item><title><![CDATA[Bird & Feeder]]>&nbsp;Kit &amp; More</title></item></channel></rss>`);
    expect(item?.title).toBe("Bird & Feeder\u00a0Kit & More");
  });

  it("strips a UTF-8 BOM before parsing XML", () => {
    const [item] = parseFeed("\uFEFF<rss><channel><item><id>BOM-1</id><title>Bom product</title></item></channel></rss>");
    expect(item).toMatchObject({ id: "BOM-1", title: "Bom product" });
  });

  it("parses Atom entries and selects the alternate link", () => {
    const [item] = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>ATOM-1</id><title>Atom product</title><link rel="self" href="https://shop.example/feed/1"/><link rel="alternate" href="https://shop.example/p/atom-1"/><price>25 USD</price></entry></feed>`);
    expect(item).toMatchObject({ id: "ATOM-1", title: "Atom product", link: "https://shop.example/p/atom-1", price: "25 USD" });
  });

  it("rejects malformed XML with a line number and nearby content", () => {
    expect(() => parseFeed("<rss>\n  <channel><item></channel>\n</rss>"))
      .toThrow(/Feed XML 第 \d+ 行第 \d+ 列解析失败.*附近内容：/);
  });

  it.each([
    ["HTML content type", "text/html; charset=utf-8", "<rss><channel/></rss>"],
    ["HTML document body", "application/octet-stream", "  <!doctype html><html><body>login</body></html>"],
    ["HTML root element", "application/octet-stream", "\uFEFF  <html><body>login</body></html>"],
  ])("rejects a website response returned as %s", async (_label, contentType, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": contentType } })));
    await expect(readFeeds({ base_url: "https://shop.example", crawl: { feed_url: "https://shop.example/feed" } }))
      .rejects.toMatchObject({
        code: "FEED_FETCH_FAILED",
        message: "这个地址返回的是网页而不是商品 feed（可能需要登录，或是 Google 表格/后台页面的链接）。请填写 Merchant Center 数据源中的'抓取网址'。",
      } satisfies Partial<FeedError>);
  });

  it("parses ten thousand feed rows in under two seconds", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => `<item><id>SKU-${index}</id><title>Product ${index}</title><price>12.00 USD</price></item>`).join("");
    const source = `<rss><channel>${rows}</channel></rss>`;
    const startedAt = performance.now();
    expect(parseFeed(source)).toHaveLength(10_000);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
