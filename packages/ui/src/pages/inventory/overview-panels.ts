type OverviewStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): OverviewStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(projectId: string): string {
  return `siteindex:inventory-overview-panels:${encodeURIComponent(projectId)}`;
}

export function readOverviewPanelsExpanded(projectId: string, storage = browserStorage()): boolean {
  try {
    return storage?.getItem(storageKey(projectId)) === "true";
  } catch {
    return false;
  }
}

export function saveOverviewPanelsExpanded(projectId: string, expanded: boolean, storage = browserStorage()): void {
  try {
    storage?.setItem(storageKey(projectId), String(expanded));
  } catch {
    // 本地存储不可用时仍允许当前页面切换面板。
  }
}
