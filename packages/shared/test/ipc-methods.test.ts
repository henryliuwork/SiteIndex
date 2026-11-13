import { describe, expect, it } from "vitest";
import type { AppSettings, CreateProjectInput, ListQuery, PageSize, SiteIndexApi } from "../src/api";
import type { SiteConfig, SkuTags } from "../src/models";
import type { SiteIndexErrorCode } from "../src/errors";
import { API_INVOKE_METHODS, PENDING_HANDLERS } from "../src/ipc-methods";
import { CSV_HEADERS, pathsFor } from "../src/paths";

describe("shared IPC method contract", () => {
  it("marks project todo methods as contracted but not implemented", () => {
    const legacyApi: Pick<SiteIndexApi, "todos"> = {};

    expect(legacyApi.todos).toBeUndefined();
    for (const method of ["todos.list", "todos.update", "todos.history"] as const) {
      expect(API_INVOKE_METHODS.filter((entry) => entry === method)).toHaveLength(1);
      expect(PENDING_HANDLERS).toContain(method);
    }
  });

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
    expect(PENDING_HANDLERS).not.toContain("seo.getRuleSettings");
  });

  it("adds the K4 workspace invoke contracts while keeping old bridges assignable", () => {
    const legacyWorkspace: Pick<SiteIndexApi, "workspace"> = {};
    const legacyWorkspaceProject: Pick<SiteIndexApi["projects"], "createWorkspaceOnly"> = {};
    const legacySettings: Pick<AppSettings, "close_to_tray" | "launch_at_login"> = {};
    const legacyCreateInput: Pick<CreateProjectInput, "workspace"> = {};
    const legacyConfig: Pick<SiteConfig, "workspace"> = {};
    const legacyCrawlConfig: Pick<SiteConfig["crawl"], "stock_verify" | "stock_rules"> = {};
    const legacyEdmConfig: Pick<NonNullable<SiteConfig["edm"]>, "image_host" | "discount_tiers"> = {};
    const emptyWorkspaceError: SiteIndexErrorCode = "WORKSPACE_NOT_EMPTY";
    const workspaceMethods = [
      "projects.createWorkspaceOnly",
      "workspace.check",
      "workspace.create",
      "workspace.importCheck",
    ];

    expect(legacyWorkspace.workspace).toBeUndefined();
    expect(legacyWorkspaceProject.createWorkspaceOnly).toBeUndefined();
    expect(legacySettings).toEqual({});
    expect(legacyCreateInput).toEqual({});
    expect(legacyConfig).toEqual({});
    expect(legacyCrawlConfig).toEqual({});
    expect(legacyEdmConfig).toEqual({});
    expect(emptyWorkspaceError).toBe("WORKSPACE_NOT_EMPTY");
    for (const method of workspaceMethods) {
      expect(API_INVOKE_METHODS).toContain(method);
      expect(PENDING_HANDLERS).not.toContain(method);
    }
  });

  it("adds optional layout-resolved design artifact paths without changing the invoke methods", () => {
    type DesignResult = Awaited<ReturnType<SiteIndexApi["design"]["get"]>>;
    const legacyDesignResult: DesignResult = { tokens: null, screenshots: [] };
    const workspaceDesignResult: DesignResult = {
      tokens: null,
      screenshots: [],
      artifact_paths: {
        tokens: pathsFor("workspace").designTokens,
        brand: pathsFor("workspace").designBrand,
      },
    };

    expect(legacyDesignResult.artifact_paths).toBeUndefined();
    expect(workspaceDesignResult.artifact_paths).toEqual({
      tokens: "_site-index/design/tokens.json",
      brand: "_site-index/design/brand.md",
    });
    expect(API_INVOKE_METHODS.filter((method) => method === "design.get")).toHaveLength(1);
    expect(PENDING_HANDLERS).not.toContain("design.get");
  });

  it("adds optional EDM discount-tier selection while preserving old tags rows and bridges", () => {
    const oldTagRow: Omit<SkuTags, "discount_tier"> = {
      sku: "DEMO-001",
      tags: null,
      priority: null,
      exclude_edm: 0,
      note: null,
      updated_at: "2026-11-12",
    };
    const legacyEdm: Pick<SiteIndexApi["edm"], "setDiscountTier"> = {};
    const unselectedTag: SkuTags = { ...oldTagRow };
    const invalidTierError: SiteIndexErrorCode = "EDM_DISCOUNT_TIER_INVALID";
    const invalidCurrencyError: SiteIndexErrorCode = "EDM_CURRENCY_INVALID";

    expect(legacyEdm.setDiscountTier).toBeUndefined();
    expect(unselectedTag.discount_tier).toBeUndefined();
    expect(invalidTierError).toBe("EDM_DISCOUNT_TIER_INVALID");
    expect(invalidCurrencyError).toBe("EDM_CURRENCY_INVALID");
    expect(API_INVOKE_METHODS).toContain("edm.setDiscountTier");
    expect(PENDING_HANDLERS).not.toContain("edm.setDiscountTier");
    expect(CSV_HEADERS.skuTagsV2.slice(-1)).toEqual(["discount_tier"]);
    expect(CSV_HEADERS.skuTags).toEqual([
      "sku", "tags", "priority", "exclude_edm", "email_blurb", "season", "note", "updated_at",
    ]);
    expect(CSV_HEADERS.skuTagsV2.slice(0, -1)).toEqual([
      "sku", "tags", "priority", "exclude_edm", "email_blurb", "season", "note", "updated_at",
    ]);
  });
});
