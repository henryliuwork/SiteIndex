import { describe, expect, it, vi } from "vitest";
import { createApiBridge } from "./api.js";

describe("createApiBridge IPC errors", () => {
  it("restores a serialized error when Electron prefixes the remote method context", async () => {
    const bridge = createApiBridge({
      invoke: async () => {
        throw new Error(
          'Error invoking remote method \'si:projects.inspectFeed\': Error: __SITEINDEX_IPC_ERROR__:{"code":"FEED_INVALID","message":"Feed 地址无效","detail":"HTTP 403"}',
        );
      },
      listen: () => () => undefined,
    });

    await expect(
      bridge.projects.inspectFeed(["https://example.test/feed.xml"], {
        sku_field: "id",
        category_depth: 2,
      }),
    ).rejects.toMatchObject({
      code: "FEED_INVALID",
      message: "Feed 地址无效",
      detail: "HTTP 403",
    });
  });

  it("preserves unrelated transport errors", async () => {
    const transportError = new Error("IPC channel unavailable");
    const bridge = createApiBridge({
      invoke: async () => {
        throw transportError;
      },
      listen: () => () => undefined,
    });

    await expect(bridge.projects.inspectFeed([], { sku_field: "id", category_depth: 2 })).rejects.toBe(transportError);
  });

  it("forwards SKU grouping previews through the API bridge", async () => {
    const result = {
      parents: 1,
      children: 2,
      samples: [{ parent: "parent", children: ["parent-A", "parent-B"] }],
      unmatched: 1,
    };
    const invoke = vi.fn(async () => result);
    const bridge = createApiBridge({ invoke, listen: () => () => undefined });
    const rule = { type: "suffix" as const, value: "-A" };

    await expect(bridge.sku?.previewGrouping("demo", rule)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("si:sku.previewGrouping", "demo", rule);
  });

  it("restores Core validation errors from SKU grouping IPC", async () => {
    const bridge = createApiBridge({
      invoke: async () => {
        throw new Error(
          'Error invoking remote method \'si:sku.previewGrouping\': Error: __SITEINDEX_IPC_ERROR__: {"code":"CONFIG_INVALID","message":"SKU 分组规则无效","detail":"正则表达式语法无效"}',
        );
      },
      listen: () => () => undefined,
    });

    await expect(bridge.sku?.previewGrouping("demo", { type: "regex", value: "[" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "SKU 分组规则无效",
      detail: "正则表达式语法无效",
    });
  });
});
