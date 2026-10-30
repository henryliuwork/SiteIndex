import { describe, expect, it } from "vitest";
import type { SiteIndexApi } from "../src/api";
import { API_INVOKE_METHODS, PENDING_HANDLERS } from "../src/ipc-methods";

describe("shared IPC method contract", () => {
  it("keeps the not-yet-implemented SKU preview namespace optional and pending", () => {
    const legacyApi: Pick<SiteIndexApi, "sku"> = {};

    expect(legacyApi.sku).toBeUndefined();
    expect(API_INVOKE_METHODS.filter((method) => method === "sku.previewGrouping")).toHaveLength(1);
    expect(PENDING_HANDLERS).toContain("sku.previewGrouping");
    for (const method of PENDING_HANDLERS) {
      expect((API_INVOKE_METHODS as readonly string[]).includes(method)).toBe(true);
    }
  });
});
