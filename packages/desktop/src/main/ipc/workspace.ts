import type { WorkspaceCreateInput } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createWorkspaceHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "workspace.check": (targetDir) => context.core.workspace.check(targetDir as string),
    "workspace.create": (input) => context.core.workspace.create(input as WorkspaceCreateInput),
  };
}
