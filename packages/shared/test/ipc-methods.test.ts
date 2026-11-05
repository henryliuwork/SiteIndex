import { describe, expect, it } from "vitest";
import type { ListQuery, PageSize, SiteIndexApi } from "../src/api";
import { API_INVOKE_METHODS, PENDING_HANDLERS } from "../src/ipc-methods";

describe("shared IPC method contract", () => {
  it("keeps the SKU preview method in the invoke contract after its Desktop handler is implemented", () => {
    const legacyApi: Pick<SiteIndexApi, "sku"> = {};

    expect(legacyApi.sku).toBeUndefined();
    expect(API_INVOKE_METHODS.filter((method) => method === "sku.previewGrouping")).toHaveLength(1);
    expect(PENDING_HANDLERS).not.toContain("sku.previewGrouping");
    for (const method of PENDING_HANDLERS) {
      expect((API_INVOKE_METHODS as readonly string[]).includes(method)).toBe(true);
    }
  });

  it("adds v0.3 table page sizes without breaking legacy page sizes or SEO bridges", () => {
    const pageSizes: PageSize[] = [20, 50, 100, 200, 0];
    const legacyQuery: ListQuery = { page: 1, pageSize: 10 };
    const legacySeo: Pick<SiteIndexApi["seo"], "getRuleSettings"> = {};

    expect(pageSizes).toEqual([20, 50, 100, 200, 0]);
    expect(legacyQuery.pageSize).toBe(10);
    expect(legacySeo.getRuleSettings).toBeUndefined();
    expect(API_INVOKE_METHODS).toContain("seo.getRuleSettings");
    expect(PENDING_HANDLERS).toContain("seo.getRuleSettings");
  });
});
