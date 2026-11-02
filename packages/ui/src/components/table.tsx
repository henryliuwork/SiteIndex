import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from "lucide-react";
import type { ListQuery } from "@siteindex/shared";
import { Button, ColumnCheckbox, Pagination, Popover } from "./primitives";
import { useColumnPrefs } from "./utils";
import { assertCompatibleRowText, calculateColumnWidths } from "./table-layout";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    reserved?: boolean;
    defaultHidden?: boolean;
    /** 基准宽度(px)，参与 colgroup 计算。 */
    width?: number;
    /** 剩余空间分配权重：0 固定，1 次要伸缩，2 主要伸缩。默认 0。 */
    grow?: 0 | 1 | 2;
    /** 最小宽度(px)，列宽低于此值时表格出现横向滚动。 */
    minWidth?: number;
    align?: "start" | "end";
    /** single 单行省略，clamp2 两行省略，wrap 自由换行。 */
    text?: "single" | "clamp2" | "wrap";
  }
}

export interface DataTableProps<T, F = Record<string, unknown>> {
  tableId: string;
  scopeId?: string;
  rows: T[];
  total: number;
  columns: ColumnDef<T, unknown>[];
  query: ListQuery<F>;
  onQueryChange: (query: ListQuery<F>) => void;
  onRowClick?: (row: T) => void;
  getRowId?: (row: T, index: number) => string;
  maxHeight?: number;
  rowHeight?: number;
  showHeader?: boolean;
  showPagination?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  toolbar?: ReactNode;
}

function getColumnId<T>(column: ColumnDef<T, unknown>, index: number): string {
  if (column.id) return column.id;
  if ("accessorKey" in column && typeof column.accessorKey === "string") return column.accessorKey;
  return "column-" + index;
}

function pageSizeValue(value: number): 20 | 50 | 100 {
  return value === 50 ? 50 : value === 100 ? 100 : 20;
}

export function DataTable<T, F = Record<string, unknown>>({
  tableId, scopeId, rows, total, columns, query, onQueryChange, onRowClick, getRowId,
  maxHeight = 560, rowHeight = 44, showHeader = true, showPagination = true, emptyTitle = "暂无数据", emptyDescription = "调整搜索条件或筛选后再试。", toolbar,
}: DataTableProps<T, F>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const columnIds = useMemo(() => columns.map(getColumnId), [columns]);
  const defaultVisible = useMemo(() => columns.flatMap((column, index) => column.meta?.defaultHidden ? [] : [getColumnId(column, index)]), [columns]);
  const columnPrefs = useColumnPrefs(tableId, scopeId);
  const columnIdsKey = columnIds.join("\u0000");
  const defaultsKey = defaultVisible.join("\u0000");
  useEffect(() => columnPrefs.configure(columnIds, defaultVisible), [columnPrefs.configure, columnIdsKey, defaultsKey]);
  const visibleColumnIds = columnPrefs.visible ?? defaultVisible;
  const columnVisibility = useMemo(() => Object.fromEntries(columnIds.map((id) => [id, visibleColumnIds.includes(id)])), [columnIds, visibleColumnIds]);
  const sorting: SortingState = query.sort ? [{ id: query.sort.field, desc: query.sort.dir === "desc" }] : [];
  const table = useReactTable({
    data: rows,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
    state: { columnVisibility, sorting },
  });
  const visibleColumns = table.getVisibleLeafColumns();
  const columnWidths = calculateColumnWidths(visibleColumns.map((column) => column.columnDef.meta ?? {}), availableWidth);
  const tableWidth = columnWidths.reduce((totalWidth, width) => totalWidth + width, 0);
  const rowModel = table.getRowModel();
  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const firstVirtualRow = virtualRows[0];
  const lastVirtualRow = virtualRows[virtualRows.length - 1];
  const visibleColumnCount = Math.max(1, visibleColumns.length);
  const pageSize = pageSizeValue(query.pageSize);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateWidth = () => setAvailableWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (import.meta.env.DEV) {
    assertCompatibleRowText(columns, rowHeight, true);
  }

  const sortBy = (columnId: string) => {
    const dir = query.sort?.field === columnId && query.sort.dir === "asc" ? "desc" : "asc";
    onQueryChange({ ...query, page: 1, sort: { field: columnId, dir } });
  };

  const columnMenu = (
    <div className="si-column-menu">
      <div className="si-column-menu-heading">显示列</div>
      {table.getAllLeafColumns().map((column) => {
        const reserved = Boolean(column.columnDef.meta?.reserved);
        const canHide = column.getCanHide() && !reserved;
        return (
          <ColumnCheckbox
            key={column.id}
            label={typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
            checked={column.getIsVisible()}
            disabled={!canHide || (column.getIsVisible() && table.getVisibleLeafColumns().length <= 1)}
            onCheckedChange={() => columnPrefs.toggle(column.id)}
          />
        );
      })}
      <Button size="small" variant="quiet" onClick={columnPrefs.reset}>恢复默认</Button>
    </div>
  );

  return (
    <section className="si-data-table" aria-label={tableId + " 数据表"}>
      <div className="si-table-toolbar">
        <div className="si-table-toolbar-content">{toolbar}</div>
        <div className="si-table-toolbar-settings">
          <Popover trigger={<Button size="small" icon={<Columns3 size={15} />}>列设置</Button>} className="si-column-popover">
            {columnMenu}
          </Popover>
        </div>
      </div>
      <div className="si-table-scroll" ref={scrollRef} style={{ height: maxHeight }}>
        <table className="si-table" style={{ width: tableWidth }}>
          <colgroup>
            {visibleColumns.map((column, index) => (
              <col
                key={column.id}
                style={{ width: tableWidth ? `${(columnWidths[index] ?? 0) / tableWidth * 100}%` : undefined }}
              />
            ))}
          </colgroup>
          {showHeader && <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const reserved = Boolean(header.column.columnDef.meta?.reserved);
                  const align = header.column.columnDef.meta?.align;
                  return (
                    <th key={header.id} className={reserved ? "is-reserved" : ""} style={align ? { textAlign: align === "end" ? "right" : "left" } : undefined} aria-sort={sorted ? sorted === "asc" ? "ascending" : "descending" : "none"}>
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button className="si-sort-button" type="button" onClick={() => sortBy(header.column.id)}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span className="si-sort-indicator" aria-hidden="true">{sorted === "asc" ? <ArrowUp size={12} /> : sorted === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</span>
                        </button>
                      ) : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>}
          <tbody>
            {rowModel.rows.length === 0 ? (
              <tr><td colSpan={visibleColumnCount}><div className="si-table-empty"><strong>{emptyTitle}</strong><span>{emptyDescription}</span></div></td></tr>
            ) : (
              <>
                {firstVirtualRow && firstVirtualRow.start > 0 && <tr aria-hidden="true" className="si-virtual-space"><td colSpan={visibleColumnCount} style={{ height: firstVirtualRow.start }} /></tr>}
                {virtualRows.map((virtualRow) => {
                  const row = rowModel.rows[virtualRow.index];
                  if (!row) return null;
                  return (
                    <tr
                      key={row.id}
                      className={(onRowClick ? "is-clickable " : "") + (selectedRowId === row.id ? "is-selected" : "")}
                      aria-selected={selectedRowId === row.id}
                      tabIndex={onRowClick ? 0 : undefined}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("button,a,input")) return;
                        event.currentTarget.focus();
                        setSelectedRowId(row.id);
                        onRowClick?.(row.original);
                      }}
                      onKeyDown={(event) => {
                        if (onRowClick && (event.key === "Enter" || event.key === " ")) {
                          if ((event.target as HTMLElement).closest("button,a,input,select,textarea,[contenteditable=true]")) return;
                          event.preventDefault();
                          setSelectedRowId(row.id);
                          onRowClick(row.original);
                        }
                      }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        const text = meta?.text ?? "single";
                        const titleValue = cell.getValue();
                        const title = typeof titleValue === "string" || typeof titleValue === "number" ? String(titleValue) : undefined;
                        const textClass = text === "clamp2" ? "si-cell-2" : text === "wrap" ? "si-cell-wrap" : "si-cell-1";
                        return (
                          <td key={cell.id} className={meta?.reserved ? "is-reserved" : ""} style={meta?.align ? { textAlign: meta.align === "end" ? "right" : "left" } : undefined}>
                            <div className={textClass} title={title}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {lastVirtualRow && lastVirtualRow.end < virtualizer.getTotalSize() && <tr aria-hidden="true" className="si-virtual-space"><td colSpan={visibleColumnCount} style={{ height: virtualizer.getTotalSize() - lastVirtualRow.end }} /></tr>}
              </>
            )}
          </tbody>
        </table>
      </div>
      {showPagination && <Pagination
        page={query.page}
        pageSize={pageSize}
        total={total}
        onPageChange={(page) => onQueryChange({ ...query, page })}
        onPageSizeChange={(nextSize) => onQueryChange({ ...query, page: 1, pageSize: nextSize })}
      />}
    </section>
  );
}
