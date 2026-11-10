import type { WorkspaceCreateInput } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createWorkspaceHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "workspace.check": (targetDir) => context.core.workspace.check(targetDir as string),
    "workspace.create": (input) => context.core.workspace.create(input as WorkspaceCreateInput),
    "workspace.importCheck": (id, options) =>
      context.withProject(id, async (projectId) => {
        const result = await context.core.workspace.importCheck(
          projectId,
          options as Parameters<IpcContext["core"]["workspace"]["importCheck"]>[1],
        );
        if (result.repaired.length > 0) {
          context.core.invalidate(context.projects.resolveProject(projectId));
        }
        return result;
      }),
  };
}
