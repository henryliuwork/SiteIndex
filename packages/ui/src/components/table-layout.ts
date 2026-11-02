import type { ColumnDef, RowData } from "@tanstack/react-table";

export interface TableColumnWidthMeta {
  width?: number;
  grow?: 0 | 1 | 2;
  minWidth?: number;
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/** Calculates widths for the columns that are currently visible. */
export function calculateColumnWidths(columns: TableColumnWidthMeta[], availableWidth: number): number[] {
  if (columns.length === 0) return [];

  const normalizedAvailable = typeof availableWidth === "number" && Number.isFinite(availableWidth) && availableWidth > 0
    ? availableWidth
    : columns.length * 160;
  const bases = columns.map((column) => {
    const width = nonNegative(column.width);
    const minWidth = nonNegative(column.minWidth) ?? 0;
    return Math.max(width ?? minWidth, minWidth);
  });
  const baseTotal = bases.reduce((total, width) => total + width, 0);
  const growTotal = columns.reduce((total, column) => total + (column.grow ?? 0), 0);
  const flexibleColumns = columns.flatMap((column, index) => column.width === undefined && column.grow === undefined ? [index] : []);
  const targetWidth = Math.max(normalizedAvailable, baseTotal);
  const remaining = targetWidth - baseTotal;

  if (remaining <= 0) return bases;
  if (growTotal > 0) {
    return bases.map((width, index) => width + remaining * (columns[index]?.grow ?? 0) / growTotal);
  }
  if (flexibleColumns.length > 0) {
    const share = remaining / flexibleColumns.length;
    return bases.map((width, index) => width + (flexibleColumns.includes(index) ? share : 0));
  }
  return bases;
}

/** In the current DataTable implementation, every table is virtualized. */
export function assertCompatibleRowText<TData extends RowData>(columns: ColumnDef<TData, unknown>[], rowHeight: number, virtualized: boolean): void {
  for (const column of columns) {
    const text = column.meta?.text;
    if (virtualized && text === "wrap") {
      throw new Error("DataTable 不支持在虚拟滚动表格中使用 text: \"wrap\"；请改用 single 或 clamp2。");
    }
    if (virtualized && text === "clamp2" && rowHeight < 52) {
      throw new Error("DataTable 使用 text: \"clamp2\" 时，虚拟行高必须至少为 52px。");
    }
  }
}
