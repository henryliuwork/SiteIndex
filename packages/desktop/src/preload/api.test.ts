import { describe, expect, it } from "vitest";
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
});
