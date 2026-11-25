import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronUp, Columns3, GripVertical, LockKeyhole } from "lucide-react";
import type { ListQuery } from "@siteindex/shared";
import { Button, ColumnCheckbox, Pagination, Popover } from "./primitives";
import { InfoTooltip } from "./info-tooltip";
import { normalizeColumnPrefs, useColumnPrefs, useTablePageSize } from "./utils";
import { assertCompatibleRowText, calculateColumnWidths, findColumnsWithoutWidthContract } from "./table-layout";

const warnedWidthContracts = new Set<string>();
const FILL_SCROLL_COMPACT_THRESHOLD = 80;
const FILL_SCROLL_COMPACT_MIN_HEIGHT = 80;
const FILL_TABLE_COMPACT_MIN_HEIGHT = 180;

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    reserved?: boolean;
    defaultHidden?: boolean;
    /** 由调用方根据完整数据判定；仅影响默认列设置，不覆盖用户选择。 */
    allEmpty?: boolean;
    /** 表头口径说明，显示在排序按钮之外。 */
    help?: string;
    /** 基准宽度(px)，参与 colgroup 计算。 */
    width?: number;
    /** 剩余空间分配权重：0 固定，1 次要伸缩，2 主要伸缩。默认 0。 */
    grow?: 0 | 1 | 2;
    /** 最小宽度(px)，列宽低于此值时表格出现横向滚动。 */
    minWidth?: number;
    align?: "start" | "center" | "end";
    /** single 单行省略，clamp2 两行省略，wrap 自由换行。 */
    text?: "single" | "clamp2" | "wrap";
    /** 标识列可固定在左侧，操作列可固定在右侧；actions 列 ID 仍会自动固定在右侧。 */
    sticky?: "left" | "right";
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
  selectable?: boolean;
  onSelectionChange?: (rows: T[]) => void;
  getRowId?: (row: T, index: number) => string;
  height?: number | "fill";
  rowHeight?: number;
  showHeader?: boolean;
  /** @deprecated DataTable v2 always renders the standard pagination footer. */
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

export function DataTable<T, F = Record<string, unknown>>({
  tableId, scopeId, rows, total, columns, query, onQueryChange, onRowClick, getRowId,
  height = "fill", rowHeight, selectable = false, onSelectionChange, showHeader = true, emptyTitle = "暂无数据", emptyDescription = "调整搜索条件或筛选后再试。", toolbar,
}: DataTableProps<T, F>) {
  const isFill = height === "fill";
  const resolvedRowHeight = rowHeight ?? (columns.some((column) => column.meta?.text === "clamp2") ? 52 : 40);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSelectionRef = useRef<HTMLInputElement>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [pinnedActionRowIds, setPinnedActionRowIds] = useState<string[]>([]);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [compactFillFallback, setCompactFillFallback] = useState(false);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [draftVisible, setDraftVisible] = useState<string[]>([]);
  const draggedColumnId = useRef<string | null>(null);
  const columnIds = useMemo(() => columns.map(getColumnId), [columns]);
  const defaultVisible = useMemo(() => columns.flatMap((column, index) => column.meta?.defaultHidden || column.meta?.allEmpty ? [] : [getColumnId(column, index)]), [columns]);
  const requiredColumnIds = useMemo(() => columns.flatMap((column, index) => column.enableHiding === false && !column.meta?.reserved ? [getColumnId(column, index)] : []), [columns]);
  const lockedStart = useMemo(() => columns.flatMap((column, index) => column.enableHiding === false && column.meta?.sticky !== "right" && getColumnId(column, index) !== "actions" ? [getColumnId(column, index)] : []), [columns]);
  const lockedEnd = useMemo(() => columns.flatMap((column, index) => column.meta?.sticky === "right" || getColumnId(column, index) === "actions" ? [getColumnId(column, index)] : []), [columns]);
  const columnPrefs = useColumnPrefs(tableId, scopeId);
  const pageSizeState = useTablePageSize(tableId, scopeId);
  const columnIdsKey = columnIds.join("\u0000");
  const defaultsKey = defaultVisible.join("\u0000");
  const requiredKey = requiredColumnIds.join("\u0000");
  useEffect(() => columnPrefs.configure(columnIds, defaultVisible, requiredColumnIds), [columnPrefs.configure, columnIdsKey, defaultsKey, requiredKey]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const missing = findColumnsWithoutWidthContract(columns);
    if (missing.length === 0) return;
    const warningKey = `${tableId}:${missing.join(",")}`;
    if (warnedWidthContracts.has(warningKey)) return;
    warnedWidthContracts.add(warningKey);
    console.warn(`[DataTable:${tableId}] 以下列缺少 ColumnDef.meta 宽度契约，也没有旧的 size：${missing.join(", ")}。请使用 meta.width/grow/minWidth。`);
  }, [columns, tableId]);
  const visibleColumnIds = columnPrefs.visible ?? normalizeColumnPrefs(null, columnIds, defaultVisible, requiredColumnIds);
  const orderedColumnIds = useMemo(() => {
    const locked = new Set([...lockedStart, ...lockedEnd]);
    const movable = visibleColumnIds.filter((id) => !locked.has(id));
    for (const [index, id] of columnIds.entries()) {
      if (locked.has(id) || movable.includes(id)) continue;
      const nextVisible = columnIds.slice(index + 1).find((candidate) => movable.includes(candidate));
      movable.splice(nextVisible ? movable.indexOf(nextVisible) : movable.length, 0, id);
    }
    return [...lockedStart, ...movable, ...lockedEnd];
  }, [columnIds, lockedEnd, lockedStart, visibleColumnIds]);
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
    state: { columnVisibility, columnOrder: orderedColumnIds, sorting },
  });
  const visibleColumns = table.getVisibleLeafColumns();
  const rowModel = table.getRowModel();
  const selectionWidth = selectable ? 40 : 0;
  const columnWidths = calculateColumnWidths(visibleColumns.map((column) => column.columnDef.meta ?? {}), Math.max(0, availableWidth - selectionWidth));
  const tableWidth = columnWidths.reduce((totalWidth, width) => totalWidth + width, selectionWidth);
  const stickyLeftOffsets = new Map<string, number>();
  let leftOffset = selectionWidth;
  visibleColumns.forEach((column, index) => {
    if (column.columnDef.meta?.sticky !== "left" || column.id === "actions") return;
    stickyLeftOffsets.set(column.id, leftOffset);
    leftOffset += columnWidths[index] ?? 0;
  });
  const stickyRightOffsets = new Map<string, number>();
  let stickyOffset = 0;
  for (const { index, column } of visibleColumns.map((column, index) => ({ column, index })).reverse()) {
    if (column.columnDef.meta?.sticky !== "right" && column.id !== "actions") continue;
    stickyRightOffsets.set(column.id, stickyOffset);
    stickyOffset += columnWidths[index] ?? 0;
  }
  const pinnedActionIndices = useMemo(
    () => pinnedActionRowIds.map((id) => rowModel.rows.findIndex((row) => row.id === id)).filter((index) => index >= 0),
    [pinnedActionRowIds, rowModel.rows],
  );
  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => scrollRef.current,
    initialRect: { width: availableWidth || 800, height: 400 },
    initialOffset: 0,
    estimateSize: () => resolvedRowHeight,
    overscan: 2,
    rangeExtractor: (range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const index of pinnedActionIndices) indexes.add(index);
      return [...indexes].sort((left, right) => left - right);
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const visibleColumnCount = Math.max(1, visibleColumns.length + (selectable ? 1 : 0));
  const selectedIds = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const selectedVisibleCount = rowModel.rows.filter((row) => selectedIds.has(row.id)).length;
  const allVisibleSelected = rowModel.rows.length > 0 && selectedVisibleCount === rowModel.rows.length;
  const pageSize = pageSizeState.pageSize;

  useEffect(() => {
    if (headerSelectionRef.current) headerSelectionRef.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
  }, [allVisibleSelected, selectedVisibleCount]);

  useEffect(() => {
    if (pageSizeState.ready && query.pageSize !== pageSize) onQueryChange({ ...query, page: 1, pageSize });
  }, [onQueryChange, pageSize, pageSizeState.ready, query]);

  const notifySelection = (next: Set<string>) => {
    setSelectedRowIds([...next]);
    onSelectionChange?.(rowModel.rows.filter((row) => next.has(row.id)).map((row) => row.original));
  };

  const toggleVisibleSelection = (rowId: string, checked: boolean) => {
    const next = new Set(selectedRowIds);
    if (checked) next.add(rowId);
    else next.delete(rowId);
    notifySelection(next);
  };

  const toggleAllVisibleSelection = (checked: boolean) => {
    const next = new Set(selectedRowIds);
    for (const row of rowModel.rows) {
      if (checked) next.add(row.id);
      else next.delete(row.id);
    }
    notifySelection(next);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!isFill) setCompactFillFallback(false);
    let fallbackApplied = false;
    let fallbackBaselineReady = false;
    let fallbackParentHeight = 0;
    let fallbackBaselineFrame = 0;
    const layoutParent = element.parentElement?.parentElement;
    const readLayoutParentHeight = () => layoutParent?.getBoundingClientRect().height ?? 0;
    const captureFallbackBaseline = () => {
      fallbackBaselineReady = false;
      if (typeof window.requestAnimationFrame !== "function") {
        fallbackParentHeight = readLayoutParentHeight();
        fallbackBaselineReady = true;
        return;
      }
      if (fallbackBaselineFrame) window.cancelAnimationFrame(fallbackBaselineFrame);
      fallbackBaselineFrame = window.requestAnimationFrame(() => {
        fallbackBaselineFrame = 0;
        if (!fallbackApplied) return;
        fallbackParentHeight = readLayoutParentHeight();
        fallbackBaselineReady = true;
      });
    };
    const updateLayout = () => {
      setAvailableWidth(element.clientWidth);
      if (!isFill) return;
      const hasLayoutBox = element.getClientRects().length > 0;
      if (!hasLayoutBox) return;
      if (!fallbackApplied && element.clientHeight < FILL_SCROLL_COMPACT_THRESHOLD) {
        fallbackApplied = true;
        captureFallbackBaseline();
        setCompactFillFallback(true);
      }
    };
    const clearFallbackOnParentExpansion = () => {
      if (!isFill || !fallbackApplied || !fallbackBaselineReady) return;
      if (readLayoutParentHeight() > fallbackParentHeight + 1) {
        fallbackApplied = false;
        fallbackBaselineReady = false;
        setCompactFillFallback(false);
        updateLayout();
      }
    };
    const resetFallbackAfterViewportResize = () => {
      if (fallbackApplied) {
        fallbackApplied = false;
        fallbackBaselineReady = false;
        if (fallbackBaselineFrame && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(fallbackBaselineFrame);
          fallbackBaselineFrame = 0;
        }
        setCompactFillFallback(false);
      }
      updateLayout();
    };
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(element);
    const parentObserver = isFill ? new ResizeObserver(clearFallbackOnParentExpansion) : undefined;
    if (layoutParent && parentObserver) parentObserver.observe(layoutParent);
    window.addEventListener("resize", resetFallbackAfterViewportResize);
    return () => {
      observer.disconnect();
      parentObserver?.disconnect();
      window.removeEventListener("resize", resetFallbackAfterViewportResize);
      if (fallbackBaselineFrame && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(fallbackBaselineFrame);
      }
    };
  }, [isFill]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updatePinnedRows = () => {
      const ids = [...new Set(Array.from(element.querySelectorAll<HTMLDetailsElement>("tbody tr details[open]"))
        .map((details) => details.closest<HTMLTableRowElement>("tr")?.dataset.rowId)
        .filter((id): id is string => Boolean(id)))];
      setPinnedActionRowIds((current) => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
    };
    const observer = new MutationObserver(updatePinnedRows);
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ["open"] });
    updatePinnedRows();
    return () => observer.disconnect();
  }, []);

  if (import.meta.env.DEV) {
    assertCompatibleRowText(columns, resolvedRowHeight, true);
  }

  const sortBy = (columnId: string) => {
    const dir = query.sort?.field === columnId && query.sort.dir === "asc" ? "desc" : "asc";
    onQueryChange({ ...query, page: 1, sort: { field: columnId, dir } });
  };

  const changeColumnMenuOpen = (open: boolean) => {
    if (open) {
      setDraftOrder([...orderedColumnIds]);
      setDraftVisible([...visibleColumnIds]);
    }
    draggedColumnId.current = null;
    setColumnMenuOpen(open);
  };
  const lockedIds = new Set([...lockedStart, ...lockedEnd]);
  const movableDraftIds = draftOrder.filter((id) => !lockedIds.has(id));
  const moveDraftColumn = (source: string, target: string) => {
    if (source === target || lockedIds.has(source) || lockedIds.has(target)) return;
    setDraftOrder((current) => {
      const next = [...current];
      const from = next.indexOf(source);
      const to = next.indexOf(target);
      if (from < 0 || to < 0) return current;
      next.splice(from, 1);
      next.splice(to, 0, source);
      return next;
    });
  };
  const toggleDraftColumn = (id: string, checked: boolean) => {
    if (lockedIds.has(id)) return;
    setDraftVisible((current) => checked ? [...current, id] : current.filter((item) => item !== id));
  };
  const renderColumnSetting = (id: string, locked: boolean) => {
    const column = table.getColumn(id);
    if (!column) return null;
    const index = movableDraftIds.indexOf(id);
    const label = (typeof column.columnDef.header === "string" ? column.columnDef.header : id) + (column.columnDef.meta?.allEmpty ? " · 无数据" : "");
    return <div key={id} className="si-column-menu-row" onDragOver={locked ? undefined : (event) => event.preventDefault()} onDrop={locked ? undefined : (event) => { event.preventDefault(); if (draggedColumnId.current) moveDraftColumn(draggedColumnId.current, id); draggedColumnId.current = null; }}>
      {locked ? <LockKeyhole size={14} aria-label="固定列" className="si-column-lock" /> : <span className="si-column-drag-handle" draggable onDragStart={(event) => { draggedColumnId.current = id; event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { draggedColumnId.current = null; }} aria-label={`拖动 ${label}`} role="img"><GripVertical size={14} /></span>}
      <ColumnCheckbox label={label} checked={locked || draftVisible.includes(id)} disabled={locked || (draftVisible.includes(id) && draftVisible.length <= 1)} onCheckedChange={(checked) => toggleDraftColumn(id, checked)} />
      {!locked && <span className="si-column-move-buttons">
        <button type="button" aria-label={`上移 ${label}`} disabled={index <= 0} onClick={() => moveDraftColumn(id, movableDraftIds[index - 1] ?? id)}><ChevronUp size={14} /></button>
        <button type="button" aria-label={`下移 ${label}`} disabled={index < 0 || index >= movableDraftIds.length - 1} onClick={() => moveDraftColumn(id, movableDraftIds[index + 1] ?? id)}><ChevronDown size={14} /></button>
      </span>}
    </div>;
  };

  const columnMenu = (
    <div className="si-column-menu">
      <div className="si-column-menu-heading">显示列与顺序</div>
      {lockedStart.map((id) => renderColumnSetting(id, true))}
      {movableDraftIds.map((id) => renderColumnSetting(id, false))}
      {lockedEnd.map((id) => renderColumnSetting(id, true))}
      <div className="si-column-menu-actions">
        <Button size="small" variant="quiet" onClick={() => { setDraftOrder([...columnIds]); setDraftVisible(normalizeColumnPrefs(null, columnIds, defaultVisible, requiredColumnIds)); }}>恢复默认</Button>
        <Button size="small" onClick={() => changeColumnMenuOpen(false)}>取消</Button>
        <Button size="small" variant="primary" onClick={() => { columnPrefs.save(draftOrder.filter((id) => draftVisible.includes(id) || lockedIds.has(id))); changeColumnMenuOpen(false); }}>保存</Button>
      </div>
    </div>
  );

  const virtualRowNodes: ReactNode[] = [];
  let previousVirtualEnd = 0;
  for (const virtualRow of virtualRows) {
    const row = rowModel.rows[virtualRow.index];
    if (!row) continue;
    const gapHeight = Math.max(0, virtualRow.start - previousVirtualEnd);
    if (gapHeight > 0) {
      virtualRowNodes.push(<tr key={`space-${virtualRow.index}`} aria-hidden="true" className="si-virtual-space"><td colSpan={visibleColumnCount} style={{ height: gapHeight }} /></tr>);
    }
    previousVirtualEnd = virtualRow.end;
    const selected = selectedIds.has(row.id);
    virtualRowNodes.push(
      <tr
        key={row.id}
        data-row-id={row.id}
        style={{ height: virtualRow.size }}
        className={(onRowClick ? "is-clickable " : "") + (selectedRowId === row.id || selected ? "is-selected" : "")}
        aria-selected={selectedRowId === row.id || selected}
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
        {selectable && <td className="si-table-selection-cell is-sticky-left" style={{ left: 0 }}><input type="checkbox" checked={selected} aria-label={`选择第 ${virtualRow.index + 1} 行`} onClick={(event) => event.stopPropagation()} onChange={(event) => toggleVisibleSelection(row.id, event.currentTarget.checked)} /></td>}
        {row.getVisibleCells().map((cell) => {
          const meta = cell.column.columnDef.meta;
          const text = meta?.text ?? "single";
          const titleValue = cell.getValue();
          const title = typeof titleValue === "string" || typeof titleValue === "number" ? String(titleValue) : undefined;
          const textClass = text === "clamp2" ? "si-cell-2" : text === "wrap" ? "si-cell-wrap" : "si-cell-1";
          const stickyRight = meta?.sticky === "right" || cell.column.id === "actions";
          const stickyLeft = meta?.sticky === "left" && !stickyRight;
          const className = [meta?.reserved && "is-reserved", stickyLeft && "is-sticky-left", stickyRight && "is-sticky-right"].filter(Boolean).join(" ");
          const style = { ...(meta?.align ? { textAlign: meta.align === "end" ? "right" as const : meta.align === "center" ? "center" as const : "left" as const } : {}), ...(stickyLeft ? { left: stickyLeftOffsets.get(cell.column.id) ?? 0 } : {}), ...(stickyRight ? { right: stickyRightOffsets.get(cell.column.id) ?? 0 } : {}) };
          return (
            <td key={cell.id} className={className} style={style}>
              <div className={textClass} title={title}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </div>
            </td>
          );
        })}
      </tr>,
    );
  }
  const trailingSpacerHeight = Math.max(0, virtualizer.getTotalSize() - previousVirtualEnd);

  return (
    <section
      className={`si-data-table${isFill ? " is-fill si-table-region" : ""}${compactFillFallback ? " is-compact-fill" : ""}`}
      style={compactFillFallback ? { minHeight: FILL_TABLE_COMPACT_MIN_HEIGHT } : undefined}
      aria-label={tableId + " 数据表"}
    >
      <div className="si-table-toolbar">
        <div className="si-table-toolbar-content">{toolbar}</div>
        <div className="si-table-toolbar-settings">
          <Popover trigger={<Button icon={<Columns3 size={15} />}>列设置</Button>} className="si-column-popover" open={columnMenuOpen} onOpenChange={changeColumnMenuOpen}>
            {columnMenu}
          </Popover>
        </div>
      </div>
      <div className="si-table-scroll" ref={scrollRef} style={compactFillFallback ? { minHeight: FILL_SCROLL_COMPACT_MIN_HEIGHT } : isFill ? undefined : { height }}>
        <table className="si-table" style={{ width: tableWidth }}>
          <colgroup>
            {selectable && <col style={{ width: `${selectionWidth}px` }} />}
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
                {selectable && <th className="si-table-selection-cell is-sticky-left" style={{ left: 0 }} aria-label="选择行"><input ref={headerSelectionRef} type="checkbox" checked={allVisibleSelected} aria-label="选择当前页全部行" onClick={(event) => event.stopPropagation()} onChange={(event) => toggleAllVisibleSelection(event.currentTarget.checked)} /></th>}
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const reserved = Boolean(header.column.columnDef.meta?.reserved);
                  const align = header.column.columnDef.meta?.align;
                  const help = header.column.columnDef.meta?.help;
                  const stickyRight = header.column.columnDef.meta?.sticky === "right" || header.column.id === "actions";
                  const stickyLeft = header.column.columnDef.meta?.sticky === "left" && !stickyRight;
                  const className = [reserved && "is-reserved", stickyLeft && "is-sticky-left", stickyRight && "is-sticky-right"].filter(Boolean).join(" ");
                  const style = { ...(align ? { textAlign: align === "end" ? "right" as const : align === "center" ? "center" as const : "left" as const } : {}), ...(stickyLeft ? { left: stickyLeftOffsets.get(header.column.id) ?? 0 } : {}), ...(stickyRight ? { right: stickyRightOffsets.get(header.column.id) ?? 0 } : {}) };
                  const headerContent = header.column.getCanSort() ? (
                    <button className="si-sort-button" type="button" onClick={() => sortBy(header.column.id)}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <span className="si-sort-indicator" aria-hidden="true">{sorted === "asc" ? <ArrowUp size={12} /> : sorted === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</span>
                    </button>
                  ) : flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th key={header.id} className={className} style={style} aria-sort={sorted ? sorted === "asc" ? "ascending" : "descending" : "none"}>
                      {header.isPlaceholder ? null : help ? (
                        <span className="si-table-heading">{headerContent}<InfoTooltip label={`${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}说明`} content={help} /></span>
                      ) : headerContent}
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
                {virtualRowNodes}
                {trailingSpacerHeight > 0 && <tr aria-hidden="true" className="si-virtual-space"><td colSpan={visibleColumnCount} style={{ height: trailingSpacerHeight }} /></tr>}
              </>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={query.page}
        pageSize={pageSize}
        total={total}
        onPageChange={(page) => onQueryChange({ ...query, page })}
        onPageSizeChange={(nextSize) => {
          pageSizeState.setPageSize(nextSize);
          onQueryChange({ ...query, page: 1, pageSize: nextSize });
        }}
      />
    </section>
  );
}
