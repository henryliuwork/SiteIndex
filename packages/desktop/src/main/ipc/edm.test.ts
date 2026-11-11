import type { ProjectId } from "@siteindex/shared";
import { describe, expect, it, vi } from "vitest";
import { createEdmHandlers } from "./edm.js";
import type { IpcContext } from "./context.js";

function context(edm: Record<string, unknown>, isEdmExportIndexReady = false): IpcContext {
  return {
    isEdmExportIndexReady: () => isEdmExportIndexReady,
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => callback(value as ProjectId),
    core: { edm },
  } as unknown as IpcContext;
}

describe("EDM export IPC", () => {
  it("forwards the project ID to Core when the optional capability exists", async () => {
    const exported = {
      status: "created" as const,
      path: "_site-index/edm/sku-index.md" as const,
      sku_count: 2,
      missing_image_count: 1,
    };
    const exportIndex = vi.fn(async () => exported);
    const handlers = createEdmHandlers(context({ exportIndex }, true));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).resolves.toEqual(exported);
    expect(exportIndex).toHaveBeenCalledWith("fixture-project");
  });

  it("returns NOT_IMPLEMENTED when Core export is not ready", async () => {
    const handlers = createEdmHandlers(context({}, true));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "当前版本尚未接入 EDM SKU 清单生成。",
      detail: "Core edm.exportIndex 尚未就绪。",
    });
  });

  it("does not invoke an available Core method while Desktop readiness remains pending", async () => {
    const exportIndex = vi.fn(async () => ({ status: "created" as const }));
    const handlers = createEdmHandlers(context({ exportIndex }, false));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "当前版本尚未接入 EDM SKU 清单生成。",
      detail: "Core edm.exportIndex 尚未就绪。",
    });
    expect(exportIndex).not.toHaveBeenCalled();
  });

  it("preserves Core's outcome-unknown error without converting it to success", async () => {
    const error = {
      code: "EDM_EXPORT_OUTCOME_UNKNOWN",
      message: "无法确认清单写入结果，请检查文件后重试。",
      detail: "写入后确认丢失",
    };
    const handlers = createEdmHandlers(context({ exportIndex: vi.fn(async () => Promise.reject(error)) }, true));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).rejects.toBe(error);
  });
});
