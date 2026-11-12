import type { ProjectId } from "@siteindex/shared";
import { describe, expect, it, vi } from "vitest";
import { createEdmHandlers } from "./edm.js";
import type { IpcContext } from "./context.js";

function context(
  edm: Record<string, unknown>,
  saveEdmSkuIndex?: IpcContext["saveEdmSkuIndex"],
): IpcContext {
  return {
    saveEdmSkuIndex,
    projects: { resolveProject: vi.fn(() => "C:/fixture/project") },
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => callback(value as ProjectId),
    core: { edm },
  } as unknown as IpcContext;
}

describe("EDM export IPC", () => {
  it("renders through Core then gives the project root and content to the native Save As service", async () => {
    const rendered = { content: "# Synthetic EDM\n", sku_count: 2, missing_image_count: 1 };
    const result = { status: "created" as const, file_name: "sku-index.md", sku_count: 2, missing_image_count: 1 };
    const renderIndex = vi.fn(async () => rendered);
    const saveEdmSkuIndex = vi.fn(async () => result);
    const handlers = createEdmHandlers(context({ renderIndex }, saveEdmSkuIndex));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).resolves.toEqual(result);
    expect(renderIndex).toHaveBeenCalledWith("fixture-project");
    expect(saveEdmSkuIndex).toHaveBeenCalledWith("C:/fixture/project", rendered);
  });

  it("returns NOT_IMPLEMENTED when the Core renderer is unavailable", async () => {
    const saveEdmSkuIndex = vi.fn();
    const handlers = createEdmHandlers(context({}, saveEdmSkuIndex));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "当前版本尚未接入 EDM SKU 清单生成。",
      detail: "Core 清单渲染或 Desktop 原生另存尚未就绪。",
    });
    expect(saveEdmSkuIndex).not.toHaveBeenCalled();
  });

  it("returns NOT_IMPLEMENTED when the native Save As service is unavailable", async () => {
    const renderIndex = vi.fn(async () => ({ content: "# Synthetic EDM\n", sku_count: 1, missing_image_count: 0 }));
    const handlers = createEdmHandlers(context({ renderIndex }));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "当前版本尚未接入 EDM SKU 清单生成。",
    });
    expect(renderIndex).not.toHaveBeenCalled();
  });

  it("preserves Core rendering errors", async () => {
    const error = {
      code: "EDM_EXPORT_OUTCOME_UNKNOWN",
      message: "清单渲染结果暂无法确认。",
      detail: "安全错误码",
    };
    const renderIndex = vi.fn(async () => Promise.reject(error));
    const saveEdmSkuIndex = vi.fn();
    const handlers = createEdmHandlers(context({ renderIndex }, saveEdmSkuIndex));

    await expect(handlers["edm.exportIndex"]?.("fixture-project")).rejects.toBe(error);
    expect(saveEdmSkuIndex).not.toHaveBeenCalled();
  });
});
