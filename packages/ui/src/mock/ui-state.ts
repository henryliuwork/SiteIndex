import type { ProjectUiState, SiteIndexApi } from "@siteindex/shared";
import { clone, projectKey, reply } from "./context";

export function createUiStateMock(): SiteIndexApi["uiState"] {
  const uiStates: Record<string, ProjectUiState> = {};
  return {
    get: (id) => reply(() => {
      const key = projectKey(id);
      return clone(uiStates[key] ?? (uiStates[key] = { columns: {}, page_sizes: {} }));
    }),
    set: (id, patch) => reply(() => {
      const key = projectKey(id);
      const current = uiStates[key] ?? { columns: {}, page_sizes: {} };
      const next: ProjectUiState = {
        columns: { ...current.columns, ...clone(patch.columns ?? {}) },
        page_sizes: { ...current.page_sizes, ...clone(patch.page_sizes ?? {}) },
      };
      uiStates[key] = next;
      return clone(next);
    }),
  };
}
