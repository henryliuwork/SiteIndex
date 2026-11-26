import { describe, expect, it } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";
import type { SeoIssue, SeoLink, SeoPage, SeoPageTableRow } from "@siteindex/shared";
import { issueColumns, linkColumns, pageColumns } from "../SeoPage";
import { seoPageTableColumns } from "./page-table";

function byId<T>(columns: ColumnDef<T, unknown>[], id: string) {
  const column = columns.find((item) => item.id === id || ("accessorKey" in item && item.accessorKey === id));
  expect(column, `missing column ${id}`).toBeTruthy();
  return column!;
}

describe("SEO DataTable column contract", () => {
  it("requires separate URL and title columns in the page table and compatibility view", () => {
    const rows = [{ links_internal_in: 0, links_internal_out: 0, last_issue_change_date: null }] as SeoPageTableRow[];
    const main = seoPageTableColumns(rows);
    const legacy = pageColumns([0, 60], [0, 160]);
    const assertRequiredPageColumns = <T,>(columns: ColumnDef<T, unknown>[]) => {
      expect(byId(columns, "url").enableHiding).toBe(false);
      expect(byId(columns, "title").enableHiding).toBe(false);
      expect(byId(columns, "url").header).toBe("URL");
      expect(byId(columns, "title").header).toBe("标题");
      expect(byId(columns, "url").meta?.grow).toBe(2);
      expect(byId(columns, "title").meta?.grow).toBe(2);
    };
    assertRequiredPageColumns(main);
    assertRequiredPageColumns(legacy);
  });

  it("keeps the issue label and link edge identity/name visible", () => {
    const issues = issueColumns();
    expect(byId(issues, "url").enableHiding).toBe(false);
    expect(byId(issues, "problem").enableHiding).toBe(false);

    const links = linkColumns();
    for (const id of ["from", "to", "anchor"]) expect(byId(links, id).enableHiding).toBe(false);
  });

  it("right-aligns numeric columns and defaults only fully absent optional data to hidden", () => {
    const emptyColumns = seoPageTableColumns([{ links_internal_in: undefined, links_internal_out: undefined, last_issue_change_date: null }]);
    for (const id of ["open_high", "links_internal_in", "links_internal_out"]) expect(byId(emptyColumns, id).meta?.align).toBe("end");
    for (const id of ["links_internal_in", "links_internal_out", "last_issue_change_date"]) expect(byId(emptyColumns, id).meta?.allEmpty).toBe(true);

    const populatedColumns = seoPageTableColumns([{ links_internal_in: 4, links_internal_out: 2, last_issue_change_date: "2026-11-26" }]);
    for (const id of ["links_internal_in", "links_internal_out", "last_issue_change_date"]) expect(byId(populatedColumns, id).meta?.allEmpty).not.toBe(true);
  });

  it("uses tabular number wrappers for SEO summary counts", () => {
    const row = { open_issue_counts: { high: 1, mid: 2, low: 0 } } as SeoPageTableRow;
    const column = byId(seoPageTableColumns([row]), "open_high");
    expect(typeof column.cell).toBe("function");
    if (typeof column.cell !== "function") throw new Error("open_high cell must return a rendered value");
    const cell = column.cell({ row: { original: row } } as never);
    expect(cell).toMatchObject({ props: { className: "si-seo-counts" } });
  });
});
