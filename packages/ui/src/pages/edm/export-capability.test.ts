import { describe, expect, it, vi } from "vitest";
import type { SiteIndexApi } from "@siteindex/shared";
import { getEdmExportCapability, isEdmExportDefinitiveNoWrite, isEdmExportOutcomeUnknown } from "./export-capability";

function apiWithExport(): SiteIndexApi {
  return { edm: { exportIndex: vi.fn(async () => ({ status: "created", path: "index/edm/sku-index.md", sku_count: 1, missing_image_count: 0 })) } } as unknown as SiteIndexApi;
}

describe("getEdmExportCapability", () => {
  it("contract handler 仍 pending 时保持关闭，即使 bridge 已暴露方法", () => {
    expect(getEdmExportCapability(apiWithExport(), ["edm.exportIndex"]).available).toBe(false);
  });

  it("bridge 缺少可选方法时保持关闭", () => {
    expect(getEdmExportCapability({ edm: {} } as SiteIndexApi, []).available).toBe(false);
  });

  it("handler 移出 pending 且方法存在后才开放", () => {
    const capability = getEdmExportCapability(apiWithExport(), []);
    expect(capability.available).toBe(true);
    expect(capability.reconciliationVerified).toBe(false);
  });
});

describe("isEdmExportOutcomeUnknown", () => {
  it("仅识别契约错误码 EDM_EXPORT_OUTCOME_UNKNOWN", () => {
    expect(isEdmExportOutcomeUnknown({ code: "EDM_EXPORT_OUTCOME_UNKNOWN", message: "确认超时" })).toBe(true);
    expect(isEdmExportOutcomeUnknown({ code: "WRITE_FAILED", message: "写入失败" })).toBe(false);
    expect(isEdmExportOutcomeUnknown(new Error("EDM_EXPORT_OUTCOME_UNKNOWN"))).toBe(false);
  });
});

describe("isEdmExportDefinitiveNoWrite", () => {
  it("把未启动、冲突和明确写入失败归为确认未写入", () => {
    expect(isEdmExportDefinitiveNoWrite({ code: "NOT_IMPLEMENTED" })).toBe(true);
    expect(isEdmExportDefinitiveNoWrite({ code: "EDM_INDEX_CONFLICT" })).toBe(true);
    expect(isEdmExportDefinitiveNoWrite({ code: "WRITE_FAILED" })).toBe(true);
    expect(isEdmExportDefinitiveNoWrite({ code: "EDM_EXPORT_OUTCOME_UNKNOWN" })).toBe(false);
    expect(isEdmExportDefinitiveNoWrite(new Error("unknown"))).toBe(false);
  });
});
