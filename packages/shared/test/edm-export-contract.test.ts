import { describe, expect, it } from "vitest";
import {
  API_INVOKE_METHODS,
  PENDING_HANDLERS,
  type EdmSkuIndexExportResult,
  type SiteIndexApi,
} from "../src";

describe("EDM Save As contract", () => {
  it("keeps the existing renderer call and models safe success and cancellation results", async () => {
    const saved: EdmSkuIndexExportResult = {
      status: "created",
      file_name: "sku-index.md",
      sku_count: 3,
      missing_image_count: 1,
    };
    const cancelled: EdmSkuIndexExportResult = {
      status: "cancelled",
      sku_count: 3,
      missing_image_count: 1,
    };
    const legacy: EdmSkuIndexExportResult = {
      status: "updated",
      path: "index/edm/sku-index.md",
      sku_count: 2,
      missing_image_count: 0,
    };
    const exportIndex: NonNullable<SiteIndexApi["edm"]["exportIndex"]> = async () => saved;

    expect(await exportIndex("demo-project")).toEqual(saved);
    expect(saved.file_name).toBe("sku-index.md");
    expect(cancelled.status).toBe("cancelled");
    expect(legacy.path).toBe("index/edm/sku-index.md");
    expect(API_INVOKE_METHODS).toContain("edm.exportIndex");
    expect(PENDING_HANDLERS).not.toContain("edm.exportIndex");
  });
});
