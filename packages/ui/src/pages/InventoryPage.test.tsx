import { describe, expect, it, vi } from "vitest";

describe("旧库存页导出兼容", () => {
  it("复用合并后的产品管理页，不保留独立库存页面实现", async () => {
    vi.resetModules();
    const [{ InventoryPage }, { ProductsPage }] = await Promise.all([
      import("./InventoryPage"),
      import("./ProductsPage"),
    ]);

    expect(InventoryPage).toBe(ProductsPage);
  }, 15_000);
});
