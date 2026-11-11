import { describe, expect, it } from "vitest";
import { parentStockRows } from "../../core/src/inventory/parent-stock-view";
import { makeW2SyntheticFixture, W2_SYNTHETIC_EXPECTED } from "../scripts/e-windows-v040-synthetic-fixture.mjs";

const fixture = makeW2SyntheticFixture("https://synthetic.example.invalid");
const expected = W2_SYNTHETIC_EXPECTED;

function dateAtOffset(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function stockRate(history: string): number | null {
  const available = [...history].filter((value) => value !== "-");
  return available.length ? available.filter((value) => value === "i").length / available.length : null;
}

describe("v0.4.1 W2 synthetic fixture integrity", () => {
  it("publishes a typed summary that matches the generated records", () => {
    expect(fixture.summary).toMatchObject({
      totalSkus: expected.totalSkus,
      parentGroups: expected.parentGroups,
      ungroupedSkus: expected.ungroupedSkus,
      products: expected.products,
      blogsBeforeRefresh: expected.blogsBeforeRefresh,
      issues: expected.issues,
      pages: expected.pages,
      links: expected.links,
      inStock: expected.inStock,
      outOfStock: expected.outOfStock,
      trendParentSku: expected.trendParentSku,
      trendHistory30d: expected.trendHistory30d,
      trendOnlineRate7d: expected.trendOnlineRate7d,
      trendOnlineRate30d: expected.trendOnlineRate30d,
      trendLastChangeAt: expected.trendLastChangeAt,
    });
  });

  it("keeps the crawl config and inventory category summary within contract", () => {
    expect(fixture.config.crawl.rate_limit_ms).toBeGreaterThanOrEqual(200);
    expect(fixture.skus).toHaveLength(expected.totalSkus);
    expect(fixture.latest).toHaveLength(expected.totalSkus);
    expect(fixture.skuStock).toHaveLength(expected.totalSkus);

    const latestBySku = new Map(fixture.latest.map((row) => [row.sku, row]));
    const stockBySku = new Map(fixture.skuStock.map((row) => [row.sku, row]));
    for (const row of fixture.skuStock) {
      const current = latestBySku.get(row.sku);
      expect(current?.stock_status).toBe(row.stock_status);
      expect(current?.since).toBe(row.since);
    }

    const categorySummary = fixture.dailySummaryRows.find((row) => row.category === expected.category);
    const allSummary = fixture.dailySummaryRows.find((row) => row.category === "_all");
    expect(categorySummary && allSummary && {
      total: categorySummary.total,
      in_stock: categorySummary.in_stock,
      out_of_stock: categorySummary.out_of_stock,
      preorder: categorySummary.preorder,
      unknown: categorySummary.unknown,
    }).toEqual({
      total: allSummary?.total,
      in_stock: allSummary?.in_stock,
      out_of_stock: allSummary?.out_of_stock,
      preorder: allSummary?.preorder,
      unknown: allSummary?.unknown,
    });
    expect(categorySummary).toMatchObject({
      total: expected.totalSkus,
      in_stock: expected.inStock,
      out_of_stock: expected.outOfStock,
      preorder: 0,
      unknown: 0,
    });
    expect(fixture.categories).toContainEqual(expect.objectContaining({
      slug: expected.category,
      sku_count: expected.totalSkus,
      product_count: expected.products,
      in_stock_count: expected.inStock,
    }));
  });

  it("makes each stock history, status, date, duration, rates, and events agree", () => {
    const latestBySku = new Map(fixture.latest.map((row) => [row.sku, row]));
    for (const row of fixture.skuStock) {
      const current = latestBySku.get(row.sku)!;
      const history = row.history_30d;
      expect(history).toMatch(/^[iopu-]{30}$/u);
      expect(history.at(-1)).toBe(row.stock_status === "in_stock" ? "i"
        : row.stock_status === "out_of_stock" ? "o" : row.stock_status === "preorder" ? "p" : "u");
      expect(stockRate(history.slice(-7))).toBe(row.online_rate_7d);
      expect(stockRate(history)).toBe(row.online_rate_30d);

      let trailingDays = 1;
      while (trailingDays < history.length && history.at(-trailingDays - 1) === history.at(-1)) trailingDays += 1;
      expect(row.days_in_status).toBe(trailingDays);
      expect(row.since).toBe(dateAtOffset(expected.date, -(trailingDays - 1)));
      expect(current.since).toBe(row.since);

      const transitions = [...history].slice(1).filter((symbol, index) => symbol !== history[index]);
      const recordedEvents = fixture.events.filter((event) => event.sku === row.sku && event.type === "stock_change");
      expect(row.changes_30d).toBe(transitions.length);
      expect(recordedEvents).toHaveLength(transitions.length);
      if (transitions.length) {
        expect(row.last_change).toBe("stock_change");
        expect(row.last_change_at).toBe(recordedEvents.at(-1)?.date);
      } else {
        expect(row.last_change).toBeNull();
        expect(row.last_change_at).toBeNull();
      }
    }
  });

  it("stores SEO links as a closed graph with matching page edge counts", () => {
    const pagesByUrl = new Map(fixture.seoPages.map((page) => [page.url, page]));
    const productUrls = new Set(fixture.products.map((product) => product.url));
    expect(pagesByUrl.size).toBe(expected.pages);
    expect(fixture.seoPages).toHaveLength(expected.pages);
    expect(fixture.seoLinks).toHaveLength(expected.links);

    const incoming = new Map(fixture.seoPages.map((page) => [page.url, 0]));
    const outgoing = new Map(fixture.seoPages.map((page) => [page.url, 0]));
    for (const link of fixture.seoLinks) {
      const source = pagesByUrl.get(link.from);
      const target = pagesByUrl.get(link.to);
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(link.to_type).toBe(target?.page_type);
      outgoing.set(link.from, outgoing.get(link.from)! + 1);
      incoming.set(link.to, incoming.get(link.to)! + 1);
    }
    for (const page of fixture.seoPages) {
      expect(page.links_internal_in).toBe(incoming.get(page.url));
      expect(page.links_internal_out).toBe(outgoing.get(page.url));
      if (page.page_type === "product") expect(productUrls.has(page.url)).toBe(true);
    }
    // The directed chain intentionally starts at group-000; that entry page is the fixture's one orphan.
    const intentionalOrphans = fixture.seoPages.filter((page) => page.links_internal_in === 0);
    expect(intentionalOrphans).toHaveLength(1);
    expect(intentionalOrphans[0].page_type).toBe("product");
    expect(intentionalOrphans[0].links_internal_out).toBe(1);
    expect(new URL(intentionalOrphans[0].url).pathname).toBe(expected.intentionalOrphanPath);
    for (const issue of fixture.seoIssues) {
      const page = pagesByUrl.get(issue.url);
      expect(page).toBeDefined();
      expect(issue.first_seen).toBe(issue.last_seen);
      if (issue.rule === "title_missing") expect(page?.title).toBeNull();
      else if (issue.rule === "desc_missing") expect(page?.meta_description).toBeNull();
      else throw new Error(`Unexpected synthetic SEO rule: ${issue.rule}`);
    }
  });

  it("aligns blog rows with blog SEO schema and the no-schema KPI", () => {
    const pagesByUrl = new Map(fixture.seoPages.map((page) => [page.url, page]));
    expect(fixture.blogs).toHaveLength(expected.blogsBeforeRefresh);
    const noSchema = fixture.blogs.filter((blog) => {
      const page = pagesByUrl.get(blog.url);
      return !page?.schema_types.some((value) => /article|blogposting/i.test(value));
    });
    expect(noSchema).toHaveLength(0);
    for (const blog of fixture.blogs) {
      const page = pagesByUrl.get(blog.url);
      expect(page?.page_type).toBe("blog");
      expect(page?.schema_types).toContain("BlogPosting");
      expect(blog.links_in).toBe(page?.links_internal_in);
    }
  });

  it("includes required product detail and outreach files, and exercises parent trends", () => {
    expect(fixture.productDetails).toHaveLength(expected.products);
    expect(fixture.productDetails.map((row) => row.handle).sort()).toEqual(fixture.products.map((row) => row.handle).sort());
    expect(fixture.productDetails.every((row) => row.rating === null && row.review_count === null && Array.isArray(row.breadcrumbs))).toBe(true);
    expect(fixture.outreach).toHaveLength(1);
    expect(fixture.outreach[0]).toMatchObject({ status: "contacted", added_at: expected.date });

    const grouped = parentStockRows(fixture.skuStock, expected.date);
    const parentRows = grouped.rows.filter((row) => row.is_parent === true);
    const standaloneRows = grouped.rows.filter((row) => row.is_parent !== true && !row.parent_sku);
    expect(grouped.rows).toHaveLength(expected.parentGroups + expected.ungroupedSkus);
    expect(parentRows).toHaveLength(expected.parentGroups);
    expect(standaloneRows).toHaveLength(expected.ungroupedSkus);
    expect(grouped.rows.some((row) => row.parent_sku && row.is_parent !== true)).toBe(false);

    const trend = parentRows.find((row) => row.sku === expected.trendParentSku)!;
    // Characterize current Core parent aggregation: DATA_SPEC.md currently describes parent history/rates as unavailable.
    // Keep the mismatch explicit until the data contract is reconciled; this test does not change product behavior.
    expect(trend.history_30d).toBe(expected.trendHistory30d);
    expect(trend.online_rate_7d).toBe(expected.trendOnlineRate7d);
    expect(trend.online_rate_30d).toBe(expected.trendOnlineRate30d);
    expect(trend.changes_30d).toBe(1);
    expect(trend.last_change_at).toBe(expected.trendLastChangeAt);
  });
});
