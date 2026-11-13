import { describe, expect, it } from "vitest";
import type {
  ProductChanges,
  ProductGroupFamily,
  ProductSkuBrief,
  ScenarioQueryResult,
  SiteIndexApi,
  SkuRecord,
  SkuStockView,
} from "../src";
import { API_INVOKE_METHODS, PENDING_HANDLERS, QUERY_TARGETS } from "../src";

describe("product scenario query contract", () => {
  it("keeps scenario methods optional for older product bridges and registers pending routes", () => {
    const legacyMethods: Pick<SiteIndexApi["products"], "skuBrief" | "changes" | "groupFamily"> = {};
    const methods = ["products.skuBrief", "products.changes", "products.groupFamily"] as const;

    expect(legacyMethods).toEqual({});
    for (const method of methods) {
      expect(API_INVOKE_METHODS.filter((entry) => entry === method)).toHaveLength(1);
      expect(PENDING_HANDLERS).toContain(method);
    }
    expect(QUERY_TARGETS).toContain("product-sku-brief");
    expect(QUERY_TARGETS).toContain("product-changes");
    expect(QUERY_TARGETS).toContain("product-group-family");
  });

  it("represents usable and unavailable indexed data without inventing records", () => {
    const sku: SkuRecord = {
      sku: "DEMO-001-A",
      product_id: "demo-product-1",
      handle: "demo-product",
      title: "Synthetic product",
      variant_title: "Blue",
      url: "https://example.test/products/demo-product",
      category: "Demo",
      category_source: "feed",
      price: 12,
      compare_at_price: null,
      currency: "USD",
      image_url: null,
      status: "active",
      first_seen: "2026-11-01",
      last_seen: "2026-11-13",
      updated_at: "2026-11-13",
    };
    const stock: SkuStockView = {
      sku: sku.sku,
      title: sku.title,
      variant_title: sku.variant_title,
      category: sku.category,
      price: sku.price,
      stock_status: "in_stock",
      since: "2026-11-13",
      days_in_status: 1,
      online_rate_7d: 1,
      online_rate_30d: 1,
      history_30d: "i",
      changes_30d: 0,
      last_change: null,
      last_change_at: null,
    };
    const brief: ProductSkuBrief = { sku, stock };
    const completeBrief: ScenarioQueryResult<ProductSkuBrief> = {
      data: brief,
      metadata: {
        sources: [{ kind: "catalog.skus" }, { kind: "views.sku_stock" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: [],
        quality: "complete",
        anomalies: [],
      },
    };
    const changes: ProductChanges = [{
      date: "2026-11-13",
      sku: sku.sku,
      type: "stock_change",
      from: "out_of_stock",
      to: "in_stock",
      category: sku.category,
      title: sku.title,
    }];
    const noChanges: ProductChanges = [];
    const family: ProductGroupFamily = {
      sku: sku.sku,
      role: "child",
      parent_sku: "DEMO-001",
      child_skus: [sku.sku],
      collision: null,
    };
    const unavailableBrief: ScenarioQueryResult<ProductSkuBrief> = {
      data: null,
      metadata: {
        sources: [{ kind: "catalog.skus" }],
        collected_at: null,
        missing_fields: ["catalog.skus.sku"],
        quality: "partial",
        anomalies: [{
          code: "SKU_NOT_INDEXED",
          severity: "warning",
          field: "catalog.skus.sku",
          message: "该 SKU 尚无已抓取的目录记录。",
        }],
      },
    };
    const missingStockIndex: ScenarioQueryResult<ProductSkuBrief> = {
      data: { sku, stock: null },
      metadata: {
        sources: [{ kind: "catalog.skus" }, { kind: "views.sku_stock" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: ["views.sku_stock.sku"],
        quality: "partial",
        anomalies: [{
          code: "SOURCE_MISSING",
          severity: "warning",
          field: "views.sku_stock.sku",
          message: "SKU 库存视图记录不可用。",
        }],
      },
    };
    const unavailableFamily: ScenarioQueryResult<ProductGroupFamily> = {
      data: null,
      metadata: {
        sources: [{ kind: "site.sku_grouping" }, { kind: "catalog.skus" }],
        collected_at: null,
        missing_fields: ["site.sku_grouping"],
        quality: "partial",
        anomalies: [{
          code: "SKU_GROUPING_UNAVAILABLE",
          severity: "warning",
          field: "site.sku_grouping",
          message: "当前项目没有可用的 SKU 分组配置。",
        }],
      },
    };

    expect(JSON.parse(JSON.stringify({ completeBrief, changes, noChanges, family, unavailableBrief, missingStockIndex, unavailableFamily })))
      .toEqual({ completeBrief, changes, noChanges, family, unavailableBrief, missingStockIndex, unavailableFamily });
  });
});
