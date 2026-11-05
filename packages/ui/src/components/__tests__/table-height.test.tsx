import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../table";

type Row = { label: string };

const columns: ColumnDef<Row, unknown>[] = [{ accessorKey: "label", header: "名称" }];

function renderTable(props: { height?: number | "fill"; showPagination?: boolean } = {}): string {
  return renderToStaticMarkup(<DataTable
    tableId="test.height"
    rows={[{ label: "虚构行" }]}
    total={1}
    columns={columns}
    query={{ page: 1, pageSize: 20, filters: {} }}
    onQueryChange={() => undefined}
    {...props}
  />);
}

describe("DataTable fill height", () => {
  it("uses fill mode by default and keeps pagination outside the scroll viewport", () => {
    const markup = renderTable();
    expect(markup).toContain('class="si-data-table is-fill si-table-region"');
    expect(markup).toContain('class="si-table-scroll"');
    expect(markup).not.toContain('class="si-table-scroll" style=');
    expect(markup).toContain('</table></div><div class="si-pagination"');
  });

  it("supports numeric scroll heights and always renders the standard footer", () => {
    const fixed = renderTable({ height: 280 });
    expect(fixed).toContain('class="si-data-table"');
    expect(fixed).toContain('class="si-table-scroll" style="height:280px"');
    expect(fixed).toContain('class="si-pagination"');
  });
});
