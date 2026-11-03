import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../table";
import { assertCompatibleRowText, calculateColumnWidths, findColumnsWithoutWidthContract, type TableColumnWidthMeta } from "../table-layout";

describe("DataTable column width contract", () => {
  it("distributes extra width according to grow weights", () => {
    expect(calculateColumnWidths([
      { width: 320, grow: 2, minWidth: 220 },
      { width: 88, grow: 0, minWidth: 88 },
      { width: 96, grow: 0, minWidth: 80 },
    ], 800)).toEqual([616, 88, 96]);
  });

  it("recalculates widths from the visible column set", () => {
    const columns: TableColumnWidthMeta[] = [
      { width: 320, grow: 2, minWidth: 220 },
      { width: 88, grow: 0, minWidth: 88 },
      { width: 96, grow: 0, minWidth: 80 },
    ];
    expect(calculateColumnWidths([columns[0]!, columns[2]!], 800)).toEqual([704, 96]);
  });

  it("preserves minimum widths and scrolls beyond the available width", () => {
    expect(calculateColumnWidths([
      { width: 80, minWidth: 130 },
      { width: 96, minWidth: 80 },
    ], 180)).toEqual([130, 96]);
  });

  it("uses equal fallback widths for columns without width metadata", () => {
    expect(calculateColumnWidths([{}, {}, {}], 600)).toEqual([200, 200, 200]);
  });

  it("finds columns without meta or a legacy size for the development warning", () => {
    const columns: ColumnDef<{ configured: string; legacy: string; missing: string }, unknown>[] = [
      { accessorKey: "configured", meta: { width: 120 } },
      { accessorKey: "legacy", size: 140 },
      { accessorKey: "missing" },
    ];
    expect(findColumnsWithoutWidthContract(columns)).toEqual(["missing"]);
  });

  it("rejects wrap in virtual tables and clamp2 rows shorter than 52px", () => {
    const wrap: ColumnDef<{ label: string }, unknown>[] = [{ accessorKey: "label", meta: { text: "wrap" } }];
    const clamp: ColumnDef<{ label: string }, unknown>[] = [{ accessorKey: "label", meta: { text: "clamp2" } }];
    expect(() => assertCompatibleRowText(wrap, 52, true)).toThrow(/虚拟滚动表格/);
    expect(() => assertCompatibleRowText(clamp, 44, true)).toThrow(/至少为 52px/);
    expect(() => assertCompatibleRowText(wrap, 44, false)).not.toThrow();
  });

  it("renders a colgroup for the currently visible columns", () => {
    type Row = { name: string; details: string };
    const columns: ColumnDef<Row, unknown>[] = [
      { accessorKey: "name", header: "名称", meta: { width: 320, grow: 2, minWidth: 220 } },
      { accessorKey: "details", header: "详情", meta: { defaultHidden: true, width: 220, grow: 1, minWidth: 160 } },
    ];
    const markup = renderToStaticMarkup(<DataTable
      tableId="test.columns"
      rows={[{ name: "DEMO 商品", details: "虚构描述" }]}
      total={1}
      columns={columns}
      query={{ page: 1, pageSize: 20, filters: {} }}
      onQueryChange={() => undefined}
      showPagination={false}
    />);

    expect(markup).toContain("<colgroup><col style=\"width:100%\"/></colgroup>");
    expect(markup).toContain("<table class=\"si-table\" style=\"width:320px\">");
    expect(markup).not.toContain("详情");
  });
});
