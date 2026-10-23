import { useCallback, useRef, useState } from "react";
import { gradeDescriptionLength, gradeTitleLength } from "@siteindex/shared";

export function nextFilterValue<T extends string>(current: T | undefined, candidate: T): T | undefined {
  return current === candidate ? undefined : candidate;
}

export interface PaginationModel {
  page: number;
  pageSize: 20 | 50 | 100;
  pageCount: number;
  from: number;
  to: number;
  total: number;
}

export function getPaginationModel(page: number, pageSize: number, total: number): PaginationModel {
  const normalizedSize: 20 | 50 | 100 = pageSize === 50 ? 50 : pageSize === 100 ? 100 : 20;
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / normalizedSize));
  const safePage = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const safeTotal = Math.max(0, total);
  return {
    page: safePage,
    pageSize: normalizedSize,
    pageCount,
    from: safeTotal ? (safePage - 1) * normalizedSize + 1 : 0,
    to: Math.min(safeTotal, safePage * normalizedSize),
    total: safeTotal,
  };
}

export type LengthKind = "title" | "description";
export type LengthGrade = "good" | "fair" | "poor";

export function getLengthGrade(length: number, kind: LengthKind, range?: [number, number]): LengthGrade {
  return kind === "title" ? gradeTitleLength(length, range) : gradeDescriptionLength(length, range);
}

const columnKey = (tableId: string): string => "si.cols." + tableId;

export function readColumnPrefs(tableId: string, available: readonly string[], defaults: readonly string[] = available): string[] {
  try {
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    if (!storage) return [...defaults];
    return normalizeColumnPrefs(JSON.parse(storage.getItem(columnKey(tableId)) ?? "null"), available, defaults);
  } catch {
    return [...defaults];
  }
}

function normalizeColumnPrefs(value: unknown, available: readonly string[], defaults: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [...defaults];
  const allowed = new Set(available);
  return [...new Set(value.filter((item: string) => allowed.has(item)))];
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
  const [state, setState] = useState<{
    tableId: string;
    scopeId?: string;
    availableKey: string;
    defaultsKey: string;
    available: string[];
    defaults: string[];
    visible: string[] | null;
  }>({ tableId, scopeId, availableKey: "", defaultsKey: "", available: [], defaults: [], visible: null });
  const requestVersion = useRef(0);
  const configuredKey = useRef("");
  const current = state.tableId === tableId && state.scopeId === scopeId ? state : null;

  const configure = useCallback((available: readonly string[], defaults: readonly string[] = available) => {
    const availableList = [...available];
    const defaultsList = [...defaults];
    const availableKey = availableList.join("\u0000");
    const defaultsKey = defaultsList.join("\u0000");
    const configKey = [tableId, scopeId ?? "", availableKey, defaultsKey].join("\u0001");
    if (configuredKey.current === configKey) return;
    configuredKey.current = configKey;
    const version = ++requestVersion.current;
    const base = { tableId, scopeId, availableKey, defaultsKey, available: availableList, defaults: defaultsList, visible: null as string[] | null };
    const uiState = typeof window === "undefined" ? undefined : window.siteindex?.uiState;
    if (!scopeId || !uiState) {
      setState({ ...base, visible: readColumnPrefs(tableId, availableList, defaultsList) });
      return;
    }
    setState(base);
    const fallback = () => readColumnPrefs(tableId, availableList, defaultsList);
    void uiState.get(scopeId).then((saved) => {
      if (requestVersion.current !== version) return;
      const stored = saved.columns[tableId];
      const visible = stored === undefined ? fallback() : normalizeColumnPrefs(stored, availableList, defaultsList);
      setState((previous) => previous.tableId === tableId && previous.scopeId === scopeId && previous.availableKey === availableKey && previous.defaultsKey === defaultsKey
        ? { ...previous, visible } : previous);
      if (stored === undefined) void uiState.set(scopeId, { columns: { [tableId]: visible } }).catch(() => undefined);
    }).catch(() => {
      if (requestVersion.current !== version) return;
      setState((previous) => previous.tableId === tableId && previous.scopeId === scopeId && previous.availableKey === availableKey && previous.defaultsKey === defaultsKey
        ? { ...previous, visible: fallback() } : previous);
    });
  }, [scopeId, tableId]);

  const persist = useCallback((visible: string[]) => {
    const uiState = typeof window === "undefined" ? undefined : window.siteindex?.uiState;
    if (scopeId && uiState) void uiState.set(scopeId, { columns: { [tableId]: visible } }).catch(() => writeColumnPrefs(tableId, visible));
    else writeColumnPrefs(tableId, visible);
  }, [scopeId, tableId]);

  const toggle = useCallback((id: string) => {
    if (!current) return;
    requestVersion.current += 1;
    const visible = current.visible ?? current.defaults;
    const next = visible.includes(id) ? visible.filter((item) => item !== id) : [...visible, id];
    persist(next);
    setState({ ...current, visible: next });
  }, [current, persist]);

  const reset = useCallback(() => {
    if (!current) return;
    requestVersion.current += 1;
    const next = [...current.defaults];
    persist(next);
    setState({ ...current, visible: next });
  }, [current, persist]);

  return { visible: current?.visible ?? null, configure, toggle, reset };
}
