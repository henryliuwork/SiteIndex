import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { gradeDescriptionLength, gradeTitleLength } from "@siteindex/shared";
import { api } from "../api";

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
    const parsed: unknown = JSON.parse(storage.getItem(columnKey(tableId)) ?? "null");
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return [...defaults];
    const allowed = new Set(available);
    return [...new Set(parsed.filter((item: string) => allowed.has(item)))];
  } catch {
    return [...defaults];
  }
}

export function writeColumnPrefs(tableId: string, visible: readonly string[]): void {
  try {
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    storage?.setItem(columnKey(tableId), JSON.stringify([...new Set(visible)]));
  } catch {
    // 无痕窗口或存储空间不足时继续使用当前会话的列设置。
  }
}

export function useColumnPrefs(tableId: string) {
  const { id: projectId } = useParams<{ id?: string }>();
  const requestId = useRef(0);
  const [state, setState] = useState<{
    tableId: string;
    projectId?: string;
    availableKey: string;
    defaultsKey: string;
    available: string[];
    defaults: string[];
    visible: string[] | null;
  }>({ tableId, projectId, availableKey: "", defaultsKey: "", available: [], defaults: [], visible: null });
  const current = state.tableId === tableId && state.projectId === projectId ? state : null;

  const configure = useCallback((available: readonly string[], defaults: readonly string[] = available) => {
    const availableList = [...available];
    const defaultsList = [...defaults];
    const availableKey = availableList.join("\u0000");
    const defaultsKey = defaultsList.join("\u0000");
    const request = ++requestId.current;
    setState((previous) => {
      if (previous.tableId === tableId && previous.projectId === projectId && previous.availableKey === availableKey && previous.defaultsKey === defaultsKey) return previous;
      return {
        tableId, projectId, availableKey, defaultsKey, available: availableList, defaults: defaultsList,
        visible: readColumnPrefs(tableId, availableList, defaultsList),
      };
    });
    if (!projectId || !api.uiState) return;
    void api.uiState.get(projectId).then((saved) => {
      if (request !== requestId.current) return;
      const stored = saved.columns[tableId];
      if (!stored) return;
      const allowed = new Set(availableList);
      const visible = [...new Set(stored.filter((id) => allowed.has(id)))];
      setState((previous) => previous.tableId === tableId && previous.projectId === projectId && previous.availableKey === availableKey && previous.defaultsKey === defaultsKey
        ? { ...previous, visible }
        : previous);
    }).catch(() => undefined);
  }, [projectId, tableId]);

  const toggle = useCallback((id: string) => {
    if (!current) return;
    requestId.current += 1;
    const visible = current.visible ?? current.defaults;
    const next = visible.includes(id) ? visible.filter((item) => item !== id) : [...visible, id];
    if (projectId && api.uiState) {
      void api.uiState.set(projectId, { columns: { [tableId]: next } }).catch(() => writeColumnPrefs(tableId, next));
    } else writeColumnPrefs(tableId, next);
    setState({ ...current, visible: next });
  }, [current, projectId, tableId]);

  const reset = useCallback(() => {
    if (!current) return;
    requestId.current += 1;
    const next = [...current.defaults];
    if (projectId && api.uiState) {
      void api.uiState.set(projectId, { columns: { [tableId]: next } }).catch(() => writeColumnPrefs(tableId, next));
    } else writeColumnPrefs(tableId, next);
    setState({ ...current, visible: next });
  }, [current, projectId, tableId]);

  return { visible: current?.visible ?? null, configure, toggle, reset };
}
