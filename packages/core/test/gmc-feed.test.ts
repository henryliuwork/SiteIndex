import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFeedOverrides, parseFeed, toSnapshot, writeSnapshot, type FeedSiteConfig } from "../src";

const roots: string[] = [];
afterEach(async () => {
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
});
