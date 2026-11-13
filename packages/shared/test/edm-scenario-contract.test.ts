import { describe, expect, it } from "vitest";
import type {
  EdmCampaignSafetyData,
  EdmCampaignSafetyQuery,
  EdmCandidatesData,
  EdmCandidatesQuery,
  EdmMediaGapsData,
  EdmMediaGapsQuery,
  ScenarioQueryResult,
  SiteIndexApi,
} from "../src";
import { API_INVOKE_METHODS, PENDING_HANDLERS, QUERY_TARGETS } from "../src";

describe("EDM scenario query contract", () => {
  it("keeps the three new read methods optional for older bridges and registers them", () => {
    const oldBridgeEdm: Pick<SiteIndexApi["edm"], "candidates" | "mediaGaps" | "campaignSafety"> = {};
    const methods = ["edm.candidates", "edm.mediaGaps", "edm.campaignSafety"] as const;

    expect(oldBridgeEdm).toEqual({});
    for (const method of methods) {
      expect(API_INVOKE_METHODS.filter((entry) => entry === method)).toHaveLength(1);
      expect(PENDING_HANDLERS).toContain(method);
    }
    expect(QUERY_TARGETS).toContain("edm-candidates");
    expect(QUERY_TARGETS).toContain("edm-media-gaps");
    expect(QUERY_TARGETS).toContain("edm-campaign-safety");
  });

  it("serializes deterministic candidate facts with read provenance", () => {
    const query: EdmCandidatesQuery = {
      category: "Demo",
      tag: "summer",
      stock: "in_stock",
      parent_only: true,
      include_excluded: false,
      limit: 20,
    };
    const result: ScenarioQueryResult<EdmCandidatesData> = {
      data: {
        rows: [{
          sku: "DEMO-EDM-001",
          title: "Synthetic summer product",
          category: "Demo",
          tags: ["summer"],
          stock_status: "in_stock",
          price: 24,
          compare_at_price: 30,
          currency: "USD",
          image_url: "https://assets.example.test/demo-001.jpg",
          image_source: "feed",
          priority: 2,
          last_featured: null,
          exclude_edm: false,
          discount_tier: null,
        }],
        total: 1,
      },
      metadata: {
        sources: [{ kind: "catalog.skus" }, { kind: "views.products" }, { kind: "views.sku_stock" }, { kind: "ledgers.sku_tags" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: [],
        quality: "complete",
        anomalies: [],
      },
    };

    expect(JSON.parse(JSON.stringify(query))).toEqual(query);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("represents media gaps and campaign checks as read-only local findings", () => {
    const mediaQuery: EdmMediaGapsQuery = {
      skus: ["DEMO-EDM-002"],
      stock: "in_stock",
      parent_only: false,
      limit: 50,
    };
    const safetyQuery: EdmCampaignSafetyQuery = {
      campaign_date: "2026-11-20",
      skus: ["DEMO-EDM-002"],
    };
    const gaps: ScenarioQueryResult<EdmMediaGapsData> = {
      data: {
        rows: [{
          sku: "DEMO-EDM-002",
          title: "Synthetic product without a compatible image",
          stock_status: "in_stock",
          reason: "webp_only",
          feed_image_url: "https://assets.example.test/demo-002.webp",
          manual_image_url: null,
        }],
        total: 1,
      },
      metadata: {
        sources: [{ kind: "views.products" }, { kind: "ledgers.sku_media" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: ["ledgers.sku_media.DEMO-EDM-002"],
        quality: "partial",
        anomalies: [{
          code: "EDM_IMAGE_WEBP_ONLY",
          severity: "warning",
          field: "views.products.DEMO-EDM-002.image_url",
          message: "当前索引只有 EDM 不支持的 WebP 图片。",
        }],
      },
    };
    const safety: ScenarioQueryResult<EdmCampaignSafetyData> = {
      data: {
        scope: "local_product_data",
        status: "blocked",
        checked_skus: ["DEMO-EDM-002"],
        findings: [{
          code: "webp_only",
          severity: "blocker",
          sku: "DEMO-EDM-002",
          field: "image_url",
          message: "所选产品没有可用于 EDM 的图片。",
        }],
      },
      metadata: {
        sources: [{ kind: "views.products" }, { kind: "views.sku_stock" }, { kind: "ledgers.sku_media" }, { kind: "site.edm" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: [],
        quality: "complete",
        anomalies: [],
      },
    };

    expect(JSON.parse(JSON.stringify({ mediaQuery, safetyQuery, gaps, safety }))).toEqual({ mediaQuery, safetyQuery, gaps, safety });
    expect(safety.data?.scope).toBe("local_product_data");
    expect(safety.data?.status).not.toBe("clear");
  });
});
