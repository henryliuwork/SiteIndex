import { describe, expect, it } from "vitest";
import { assertSortScopeSnapshots } from "../scripts/acceptance/sort-state-probe.mjs";

type Sort = { field: string; dir: "asc" | "desc" };
type Snapshot = { sorts: Record<string, Sort> };
const expected: Sort = { field: "price", dir: "desc" };
const baseline: Snapshot = { sorts: { "products.merged": expected } };
const scopes: { primary: Snapshot; otherProject: Snapshot; otherDevice: Snapshot;
  tableId: string; peerTableId: string; expected: Sort } = {
  primary: baseline, otherProject: { sorts: {} }, otherDevice: { sorts: {} },
  tableId: "products.merged", peerTableId: "seo.pages", expected };

describe("v0.9.0 packaged sort scope probe", () => {
  it("accepts a retained sort with separate table, project and device snapshots", () => {
    expect(() => assertSortScopeSnapshots(scopes)).not.toThrow();
  });

  it("preserves different sorts already saved in the other scopes", () => {
    const peerTableExpected: Sort = { field: "url", dir: "asc" };
    const otherProjectExpected: Sort = { field: "stock_status", dir: "asc" };
    const otherDeviceExpected: Sort = { field: "title", dir: "desc" };
    expect(() => assertSortScopeSnapshots({ ...scopes,
      primary: { sorts: { ...baseline.sorts, "seo.pages": peerTableExpected } },
      otherProject: { sorts: { "products.merged": otherProjectExpected } },
      otherDevice: { sorts: { "products.merged": otherDeviceExpected } },
      peerTableExpected, otherProjectExpected, otherDeviceExpected })).not.toThrow();
  });

  it.each(["primary", "otherProject", "otherDevice", "otherTable"])("rejects %s scope regression", (scope) => {
    const input = structuredClone(scopes);
    if (scope === "primary") input.primary.sorts["products.merged"] = { field: "price", dir: "asc" };
    else if (scope === "otherTable") input.primary.sorts["seo.pages"] = expected;
    else input[scope].sorts["products.merged"] = expected;
    expect(() => assertSortScopeSnapshots(input)).toThrow();
  });

  it("treats missing snapshots or a repeated table id as harness errors", () => {
    expect(() => assertSortScopeSnapshots({ ...scopes, peerTableId: "products.merged" })).toThrow("distinct table ids");
  });
});
