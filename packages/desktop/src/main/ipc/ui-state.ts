import type { ProjectId, ProjectUiState } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createUiStateHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "uiState.get": (id) => context.uiState.get(id as ProjectId),
    "uiState.set": (id, patch) => context.uiState.set(id as ProjectId, patch as Partial<ProjectUiState>),
  };
}
