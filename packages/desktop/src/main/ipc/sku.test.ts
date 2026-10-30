import { describe, expect, it, vi } from "vitest";
import type { ProjectId, SkuGroupingRule } from "@siteindex/shared";
import { serializeIpcError } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";
import { createSkuHandlers } from "./sku.js";

const rule: SkuGroupingRule = { type: "suffix", value: "-A" };
const preview = {
  parents: 1,
  children: 2,
  samples: [{ parent: "parent", children: ["parent-A", "parent-B"] }],
  unmatched: 1,
};

function createContext(previewGrouping = vi.fn(async () => preview)): IpcContext {
  return {
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== "demo") {
        throw { code: "PROJECT_NOT_FOUND", message: "找不到指定项目。", detail: String(value) };
      }
      return callback("demo" as ProjectId);
    },
    core: { sku: { previewGrouping } },
  } as unknown as IpcContext;
}

function getPreviewHandler(context: IpcContext) {
  const handler = createSkuHandlers(context)["sku.previewGrouping"];
  if (!handler) throw new Error("sku.previewGrouping handler is missing");
  return handler;
}

describe("sku.previewGrouping IPC handler", () => {
  it("validates the project and forwards the rule to Core", async () => {
    const previewGrouping = vi.fn(async () => preview);
    const context = createContext(previewGrouping);

    await expect(getPreviewHandler(context)("demo", rule)).resolves.toEqual(preview);
    expect(previewGrouping).toHaveBeenCalledWith("demo", rule);
  });

  it("preserves Core validation errors for an invalid grouping rule", async () => {
    const coreError = {
      code: "CONFIG_INVALID",
      message: "SKU 分组规则无效：正则表达式语法无效。",
      detail: "正则表达式语法无效。",
    };
    const previewGrouping = vi.fn(async () => preview).mockRejectedValueOnce(coreError);
    const handler = getPreviewHandler(createContext(previewGrouping));

    await expect(handler("demo", { type: "regex", value: "[" })).rejects.toEqual(coreError);
    expect(JSON.parse(serializeIpcError(coreError).message.replace(/^__SITEINDEX_IPC_ERROR__:/, ""))).toEqual(
      coreError,
    );
  });

  it("returns PROJECT_NOT_FOUND without invoking Core for an unknown project", async () => {
    const previewGrouping = vi.fn(async () => preview);
    const handler = getPreviewHandler(createContext(previewGrouping));

    await expect(handler("missing-project", rule)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(previewGrouping).not.toHaveBeenCalled();
  });

  it("serializes unexpected Core failures as UNKNOWN IPC errors", async () => {
    const previewGrouping = vi.fn(async () => preview).mockRejectedValueOnce(new Error("snapshot read failed"));
    const handler = getPreviewHandler(createContext(previewGrouping));

    const error = await Promise.resolve()
      .then(() => handler("demo", rule))
      .catch((reason: unknown) => reason);
    expect(serializeIpcError(error).message).toContain(
      '{"code":"UNKNOWN","message":"桌面操作失败","detail":"snapshot read failed"}',
    );
  });
});
