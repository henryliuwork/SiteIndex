import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { gradeDescriptionLength, gradeTitleLength, type ListQuery } from "@siteindex/shared";
import { api } from "../api";

export function nextFilterValue<T extends string>(current: T | undefined, candidate: T): T | undefined {
  return current === candidate ? undefined : candidate;
}

/** 格式化为本地时间；同年隐藏年份，跨年补全年份。 */
export function formatDateTime(value: string | Date | null | undefined, now = new Date()): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  const datePart = date.getFullYear() === now.getFullYear()
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const platformLabels: Record<string, string> = {
  magento: "Magento",
  wordpress: "WordPress",
  woocommerce: "WooCommerce",
  shopify: "Shopify",
  other: "其他平台",
};

export function formatPlatformLabel(platform: string | null | undefined): string {
  if (!platform) return "未知平台";
  return platformLabels[platform] ?? platform;
}

export interface PaginationModel {
  page: number;
  pageSize: TablePageSize;
  pageCount: number;
  from: number;
  to: number;
  total: number;
}

export type TablePageSize = 0 | 50 | 100 | 200;

export function normalizeTablePageSize(value: unknown, fallback: TablePageSize = 50): TablePageSize {
  return value === 0 || value === 50 || value === 100 || value === 200 ? value : fallback;
}

export function getPaginationModel(page: number, pageSize: number, total: number): PaginationModel {
  const normalizedSize = normalizeTablePageSize(pageSize);
  const safeTotal = Math.max(0, total);
  const pageCount = normalizedSize === 0 ? 1 : Math.max(1, Math.ceil(safeTotal / normalizedSize));
  const safePage = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  return {
    page: safePage,
    pageSize: normalizedSize,
    pageCount,
    from: safeTotal ? normalizedSize === 0 ? 1 : (safePage - 1) * normalizedSize + 1 : 0,
    to: normalizedSize === 0 ? safeTotal : Math.min(safeTotal, safePage * normalizedSize),
    total: safeTotal,
  };
}

const pageSizeKey = (tableId: string, projectId?: string): string => `si.page-size.${projectId ?? "global"}.${tableId}`;

function readTablePageSize(tableId: string, projectId?: string): TablePageSize {
  try {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(pageSizeKey(tableId, projectId));
    return normalizeTablePageSize(stored === null ? undefined : Number(stored));
  } catch {
    return 50;
  }
}

function writeTablePageSize(tableId: string, projectId: string | undefined, pageSize: TablePageSize): void {
  try { localStorage?.setItem(pageSizeKey(tableId, projectId), String(pageSize)); }
  catch { /* 私密窗口或空间不足时仍使用当前会话的页长。 */ }
}

/** 按表格 ID 读取并保存页长；项目页优先使用 uiState，应用级页面回退到 localStorage。 */
export function useTablePageSize(tableId: string, scopeId?: string) {
  const { id: routeProjectId } = useParams<{ id?: string }>();
  const projectId = scopeId ?? routeProjectId;
  const [state, setState] = useState(() => ({ tableId, projectId, pageSize: readTablePageSize(tableId, projectId), ready: !projectId || !api.uiState }));
  const current = state.tableId === tableId && state.projectId === projectId ? state : null;

  useEffect(() => {
    const fallback = readTablePageSize(tableId, projectId);
    const uiState = api.uiState;
    setState({ tableId, projectId, pageSize: fallback, ready: !projectId || !uiState });
    if (!projectId || !uiState) return;
    let active = true;
    void uiState.get(projectId).then((saved) => {
      if (!active) return;
      const stored = saved.page_sizes?.[tableId];
      const pageSize = normalizeTablePageSize(stored, fallback);
      setState({ tableId, projectId, pageSize, ready: true });
      if (stored !== pageSize) {
        // Older Desktop bridges reject newer page sizes; the table-specific localStorage value remains the fallback.
        void uiState.set(projectId, { page_sizes: { [tableId]: pageSize as 20 | 50 | 100 } }).catch(() => writeTablePageSize(tableId, projectId, pageSize));
      }
    }).catch(() => {
      if (active) setState({ tableId, projectId, pageSize: fallback, ready: true });
    });
    return () => { active = false; };
  }, [projectId, tableId]);

  const setPageSize = useCallback((pageSize: TablePageSize) => {
    if (!current) return;
    setState({ ...current, pageSize });
    writeTablePageSize(tableId, projectId, pageSize);
    const uiState = api.uiState;
    if (projectId && uiState) {
      void uiState.set(projectId, { page_sizes: { [tableId]: pageSize as 20 | 50 | 100 } }).catch(() => undefined);
    }
  }, [current, projectId, tableId]);

  return { pageSize: current?.pageSize ?? 50, ready: current?.ready ?? false, setPageSize };
}

type TableSort = NonNullable<ListQuery["sort"]>;
const sortKey = (tableId: string, projectId?: string) => `si.sort.${projectId ?? "global"}.${tableId}`;

function normalizeSort(value: unknown, fields: readonly string[]): TableSort | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const field = Reflect.get(value, "field");
  const dir = Reflect.get(value, "dir");
  return typeof field === "string" && fields.includes(field) && (dir === "asc" || dir === "desc") ? { field, dir } : undefined;
}

function readTableSort(tableId: string, projectId: string | undefined, fields: readonly string[]): TableSort | null | undefined {
  try {
    const raw = localStorage.getItem(sortKey(tableId, projectId));
    return raw === null ? undefined : normalizeSort(JSON.parse(raw), fields);
  } catch { return undefined; }
}

function writeTableSort(tableId: string, projectId: string | undefined, sort: TableSort | null): void {
  try { localStorage.setItem(sortKey(tableId, projectId), JSON.stringify(sort)); }
  catch { /* 存储不可用时保留当前会话状态。 */ }
}

/** 排序只保存于当前设备；桌面项目优先读 uiState，旧桥接拒绝新字段时读本机缓存。 */
export function useTableSort(tableId: string, fields: readonly string[], scopeId?: string) {
  const { id: routeProjectId } = useParams<{ id?: string }>();
  const projectId = scopeId ?? routeProjectId;
  const fieldsKey = fields.join("\u0000");
  const requestId = useRef(0);
  const [state, setState] = useState(() => ({ tableId, projectId, fieldsKey, sort: readTableSort(tableId, projectId, fields) }));
  const current = state.tableId === tableId && state.projectId === projectId && state.fieldsKey === fieldsKey ? state : null;

  useEffect(() => {
    const request = ++requestId.current;
    const fallback = readTableSort(tableId, projectId, fields);
    setState({ tableId, projectId, fieldsKey, sort: fallback });
    const uiState = api.uiState;
    if (!projectId || !uiState) return;
    void uiState.get(projectId).then((saved) => {
      if (request !== requestId.current) return;
      const stored = saved.sorts?.[tableId];
      const sort = stored === undefined ? fallback : normalizeSort(stored, fields);
      if (stored !== undefined && sort === undefined) {
        writeTableSort(tableId, projectId, null);
        void uiState.set(projectId, { sorts: { [tableId]: null } }).catch(() => undefined);
      }
      setState({ tableId, projectId, fieldsKey, sort });
    }).catch(() => {
      if (request === requestId.current) setState({ tableId, projectId, fieldsKey, sort: fallback });
    });
    return () => { requestId.current += 1; };
  }, [tableId, projectId, fieldsKey]);

  const save = useCallback((sort: TableSort | null) => {
    requestId.current += 1;
    const next = normalizeSort(sort, fields) ?? null;
    setState({ tableId, projectId, fieldsKey, sort: next });
    writeTableSort(tableId, projectId, next);
    if (projectId && api.uiState) {
      void api.uiState.set(projectId, { sorts: { [tableId]: next } }).catch(() => undefined);
    }
  }, [tableId, projectId, fieldsKey]);

  return { sort: current?.sort, save };
}

const sortCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** 客户端数据须先排序再分页；未知字段由调用方传 undefined，保持原始行序。 */
export function sortRows<T>(rows: readonly T[], sort: ListQuery["sort"], valueForField: (row: T, field: string) => unknown): T[] {
  if (!sort) return [...rows];
  const values = rows.map((row) => valueForField(row, sort.field));
  if (values.every((value) => value === undefined)) return [...rows];
  return rows.map((row, index) => ({ row, index, value: values[index] })).sort((left, right) => {
    if (left.value == null && right.value == null) return left.index - right.index;
    if (left.value == null) return 1;
    if (right.value == null) return -1;
    const a = left.value instanceof Date ? left.value.getTime() : left.value;
    const b = right.value instanceof Date ? right.value.getTime() : right.value;
    const order = typeof a === "number" && typeof b === "number" ? a - b
      : typeof a === "boolean" && typeof b === "boolean" ? Number(a) - Number(b)
      : sortCollator.compare(String(a), String(b));
    return order === 0 ? left.index - right.index : sort.dir === "desc" ? -order : order;
  }).map(({ row }) => row);
}

export type LengthKind = "title" | "description";
export type LengthGrade = "good" | "fair" | "poor";

export function getLengthGrade(length: number, kind: LengthKind, range?: [number, number]): LengthGrade {
  return kind === "title" ? gradeTitleLength(length, range) : gradeDescriptionLength(length, range);
}

const columnKey = (tableId: string): string => "si.cols." + tableId;

export function readColumnPrefs(tableId: string, available: readonly string[], defaults: readonly string[] = available, required: readonly string[] = []): string[] {
  try {
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    if (!storage) return normalizeColumnPrefs(null, available, defaults, required);
    const parsed: unknown = JSON.parse(storage.getItem(columnKey(tableId)) ?? "null");
    return normalizeColumnPrefs(parsed, available, defaults, required);
  } catch {
    return normalizeColumnPrefs(null, available, defaults, required);
  }
}

export function normalizeColumnPrefs(value: unknown, available: readonly string[], defaults: readonly string[], required: readonly string[] = []): string[] {
  const allowed = new Set(available);
  const saved = Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : defaults;
  const visible = [...new Set(saved.filter((item) => allowed.has(item)))];
  for (const id of required) {
    if (!allowed.has(id) || visible.includes(id)) continue;
    const before = available.slice(0, available.indexOf(id)).findLast((item) => visible.includes(item));
    visible.splice(before ? visible.indexOf(before) + 1 : 0, 0, id);
  }
  return visible;
}

export function writeColumnPrefs(tableId: string, visible: readonly string[]): void {
  try {
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    storage?.setItem(columnKey(tableId), JSON.stringify([...new Set(visible)]));
  } catch {
    // 无痕窗口或存储空间不足时继续使用当前会话的列设置。
  }
}

export function useColumnPrefs(tableId: string, scopeId?: string) {
  const { id: routeProjectId } = useParams<{ id?: string }>();
  const projectId = scopeId ?? routeProjectId;
  const requestId = useRef(0);
  const configuredKey = useRef("");
  const [state, setState] = useState<{
    tableId: string;
    projectId?: string;
    availableKey: string;
    defaultsKey: string;
    requiredKey: string;
    available: string[];
    defaults: string[];
    required: string[];
    visible: string[] | null;
  }>({ tableId, projectId, availableKey: "", defaultsKey: "", requiredKey: "", available: [], defaults: [], required: [], visible: null });
  const current = state.tableId === tableId && state.projectId === projectId ? state : null;

  const configure = useCallback((available: readonly string[], defaults: readonly string[] = available, required: readonly string[] = []) => {
    const availableList = [...available];
    const defaultsList = [...defaults];
    const availableKey = availableList.join("\u0000");
    const defaultsKey = defaultsList.join("\u0000");
    const requiredList = [...required];
    const requiredKey = requiredList.join("\u0000");
    const configKey = [tableId, projectId ?? "", availableKey, defaultsKey, requiredKey].join("\u0001");
    if (configuredKey.current === configKey) return;
    configuredKey.current = configKey;
    const request = ++requestId.current;
    const fallback = () => readColumnPrefs(tableId, availableList, defaultsList, requiredList);
    const base = { tableId, projectId, availableKey, defaultsKey, requiredKey, available: availableList, defaults: defaultsList, required: requiredList };
    setState({ ...base, visible: fallback() });
    const uiState = api.uiState;
    if (!projectId || !uiState) return;
    void uiState.get(projectId).then((saved) => {
      if (request !== requestId.current) return;
      const stored = saved.columns[tableId];
      const visible = stored === undefined ? fallback() : normalizeColumnPrefs(stored, availableList, defaultsList, requiredList);
      setState((previous) => previous.tableId === tableId && previous.projectId === projectId && previous.availableKey === availableKey && previous.defaultsKey === defaultsKey && previous.requiredKey === requiredKey
        ? { ...previous, visible }
        : previous);
    }).catch(() => {
      if (request !== requestId.current) return;
      setState((previous) => previous.tableId === tableId && previous.projectId === projectId && previous.availableKey === availableKey && previous.defaultsKey === defaultsKey && previous.requiredKey === requiredKey
        ? { ...previous, visible: fallback() }
        : previous);
    });
  }, [projectId, tableId]);

  const save = useCallback((orderedVisible: readonly string[]) => {
    if (!current) return;
    requestId.current += 1;
    const next = normalizeColumnPrefs(orderedVisible, current.available, current.defaults, current.required);
    const uiState = api.uiState;
    if (projectId && uiState) {
      void uiState.set(projectId, { columns: { [tableId]: next } }).catch(() => writeColumnPrefs(tableId, next));
    } else writeColumnPrefs(tableId, next);
    setState({ ...current, visible: next });
  }, [current, projectId, tableId]);

  return { visible: current?.visible ?? null, configure, save };
}
