// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectUiState } from "@siteindex/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { DataTable } from "../table";
import type { ListQuery } from "@siteindex/shared";

interface Row { id: string; label: string; kind: string }
const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "label", header: "名称", meta: { width: 200, grow: 1, minWidth: 120 } },
  { accessorKey: "kind", header: "类别", meta: { width: 120, minWidth: 100 } },
  { id: "actions", header: "操作", meta: { width: 68, minWidth: 68 }, cell: () => <button type="button">操作菜单</button> },
];
const rows: Row[] = [{ id: "row-1", label: "DEMO 商品一", kind: "产品" }, { id: "row-2", label: "DEMO 商品二", kind: "组合" }];
let tableScrollClientHeight = 400;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  tableScrollClientHeight = 400;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("si-table-scroll") ? tableScrollClientHeight : 400;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, contentRect: { width: 800, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  });
  localStorage.clear();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderTable(props: {
  rows?: Row[];
  pageSize?: number;
  scopeId?: string;
  selectable?: boolean;
  onSelectionChange?: (selected: Row[]) => void;
  onRowClick?: (row: Row) => void;
  onQueryChange?: (query: ListQuery) => void;
} = {}) {
  const onQueryChange = props.onQueryChange ?? vi.fn();
  const tableRows = props.rows ?? rows;
  render(<DataTable
    tableId="test.table-v2"
    scopeId={props.scopeId}
    rows={tableRows}
    total={tableRows.length}
    columns={columns}
    query={{ page: 1, pageSize: props.pageSize ?? 50, filters: {} }}
    onQueryChange={onQueryChange}
    selectable={props.selectable}
    onSelectionChange={props.onSelectionChange}
    onRowClick={props.onRowClick}
    getRowId={(row) => row.id}
    height={220}
  />);
  return onQueryChange;
}

describe("DataTable v2", () => {
  it("clears compact fill fallback when the same table switches to a fixed height", async () => {
    tableScrollClientHeight = 55;
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return { length: this.classList.contains("si-table-scroll") ? 1 : 0 } as DOMRectList;
    });
    const tableProps = (height: number | "fill") => ({
      tableId: "test.table-fill-switch",
      rows,
      total: rows.length,
      columns,
      query: { page: 1, pageSize: 50, filters: {} },
      onQueryChange: vi.fn(),
      getRowId: (row: Row) => row.id,
      height,
    });
    const { rerender } = render(<DataTable {...tableProps("fill")} />);
    await waitFor(() => expect(document.querySelector(".si-data-table")?.classList.contains("is-compact-fill")).toBe(true));

    rerender(<DataTable {...tableProps(220)} />);
    await waitFor(() => expect(document.querySelector(".si-data-table")?.classList.contains("is-compact-fill")).toBe(false));
    expect((document.querySelector(".si-data-table") as HTMLElement).style.minHeight).toBe("");
    expect((document.querySelector(".si-table-scroll") as HTMLElement).style.minHeight).toBe("");
    expect((document.querySelector(".si-table-scroll") as HTMLElement).style.height).toBe("220px");
  });

  it("keeps the actions column sticky on the right and exposes its menu outside the text clipper", () => {
    renderTable();
    const actionCell = document.querySelector("tbody td.is-sticky-right");
    expect(actionCell).toBeTruthy();
    expect(actionCell?.getAttribute("style")).toContain("right: 0");
    expect(actionCell?.querySelector(".si-cell-1")?.classList.contains("si-cell-1")).toBe(true);
  });

  it("recalculates the visible colgroup after a column is hidden", async () => {
    renderTable();
    const before = [...document.querySelectorAll("colgroup col")].map((column) => column.getAttribute("style"));
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "类别" }));
    await waitFor(() => expect(document.querySelectorAll("colgroup col")).toHaveLength(2));
    const after = [...document.querySelectorAll("colgroup col")].map((column) => column.getAttribute("style"));
    expect(after).not.toEqual(before);
    expect(after[0]).toContain("91.5%");
  });

  it("selects one row or all visible rows without firing the row action", () => {
    const onSelectionChange = vi.fn();
    const onRowClick = vi.fn();
    renderTable({ selectable: true, onSelectionChange, onRowClick });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择第 1 行" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([rows[0]]);
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前页全部行" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(rows);
  });

  it("persists the selected page size by table ID and updates the query", async () => {
    const onQueryChange = renderTable();
    fireEvent.change(screen.getByRole("combobox", { name: "每页条数" }), { target: { value: "200" } });
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 200 }));
    expect(localStorage.getItem("si.page-size.global.test.table-v2")).toBe("200");
  });

  it("loads a saved project page size from uiState", async () => {
    const uiState = api.uiState!;
    const saved = { columns: {}, page_sizes: { "test.table-v2": 100 } } as ProjectUiState;
    vi.spyOn(uiState, "get").mockResolvedValue(saved);
    const onQueryChange = renderTable({ scopeId: "demo", pageSize: 50 });
    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 100 })));
  });

  it("persists 200 and All page sizes to uiState by table ID", async () => {
    const uiState = api.uiState!;
    const saved = { columns: {}, page_sizes: {} } as ProjectUiState;
    vi.spyOn(uiState, "get").mockResolvedValue(saved);
    const setState = vi.spyOn(uiState, "set").mockResolvedValue(saved);
    renderTable({ scopeId: "demo" });
    const pageSize = screen.getByRole("combobox", { name: "每页条数" });
    fireEvent.change(pageSize, { target: { value: "200" } });
    await waitFor(() => expect(setState).toHaveBeenCalledWith("demo", { page_sizes: { "test.table-v2": 200 } }));
    fireEvent.change(pageSize, { target: { value: "0" } });
    await waitFor(() => expect(setState).toHaveBeenCalledWith("demo", { page_sizes: { "test.table-v2": 0 } }));
  });

  it("keeps newer page sizes in localStorage when the bridge rejects them", async () => {
    const uiState = api.uiState!;
    vi.spyOn(uiState, "get").mockResolvedValue({ columns: {}, page_sizes: {} } as ProjectUiState);
    vi.spyOn(uiState, "set").mockRejectedValue(new Error("该功能尚未实现"));
    renderTable({ scopeId: "demo" });
    const pageSize = screen.getByRole("combobox", { name: "每页条数" });
    fireEvent.change(pageSize, { target: { value: "0" } });
    expect(localStorage.getItem("si.page-size.demo.test.table-v2")).toBe("0");
  });

  it("virtualizes all rows when page size is All", () => {
    const allRows = Array.from({ length: 10_000 }, (_, index) => ({ id: `row-${index}`, label: `DEMO ${index}`, kind: "产品" }));
    renderTable({ rows: allRows, pageSize: 0 });
    const visibleRows = document.querySelectorAll("tbody tr:not(.si-virtual-space)");
    expect(visibleRows.length).toBeGreaterThan(0);
    expect(visibleRows.length).toBeLessThan(100);
  });
});
