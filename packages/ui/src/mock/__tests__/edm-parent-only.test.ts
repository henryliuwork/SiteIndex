import { describe, expect, it } from "vitest";
import { createEdmMock } from "../edm";
import { rowsByProject } from "../context";

describe("EDM mock parent-only filtering", () => {
  it("returns parent aggregates and lets a child SKU search find its parent row", async () => {
    const child = rowsByProject.demo[0]!;
    const secondChild = rowsByProject.demo[1]!;
    const previousParent = child.parent_sku;
    const previousSecondParent = secondChild.parent_sku;
    child.parent_sku = "DEMO-GROUP";
    secondChild.parent_sku = "DEMO-GROUP";
    try {
      const api = createEdmMock();
      const all = await api.listImages("demo", { page: 1, pageSize: 0 });
      const parents = await api.listImages("demo", { page: 1, pageSize: 0, filters: { parent_only: true } });
      const byChildSku = await api.listImages("demo", {
        page: 1,
        pageSize: 50,
        search: child.sku,
        filters: { parent_only: true },
      });

      expect(parents.total).toBeLessThan(all.total);
      expect(parents.rows.map((row) => row.sku)).toContain("DEMO-GROUP");
      expect(byChildSku.rows.map((row) => row.sku)).toContain("DEMO-GROUP");
    } finally {
      child.parent_sku = previousParent;
      secondChild.parent_sku = previousSecondParent;
    }
  });
});
