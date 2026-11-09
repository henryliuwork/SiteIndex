import { describe, expect, it } from "vitest";
import type { AppSettings, CreateProjectInput, ListQuery, PageSize, SiteIndexApi } from "../src/api";
import type { SiteConfig } from "../src/models";
import type { SiteIndexErrorCode } from "../src/errors";
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
      expect(PENDING_HANDLERS).toContain(method);
    }
  });
});
