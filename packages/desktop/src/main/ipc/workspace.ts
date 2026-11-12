import type { WorkspaceCreateInput } from "@siteindex/shared";
import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createWorkspaceHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "workspace.check": (targetDir) => context.core.workspace.check(targetDir as string),
    "workspace.create": async (input) => {
      const request = input as WorkspaceCreateInput;
      await context.assertProjectStorageLocal?.(request.targetDir);
      return context.core.workspace.create(request);
    },
    "workspace.importCheck": (id, options) =>
      context.withProject(id, async (projectId) => {
        const importOptions = options as Parameters<IpcContext["core"]["workspace"]["importCheck"]>[1];
        if (importOptions?.apply) {
          await context.assertProjectStorageLocal?.(context.projects.resolveProject(projectId));
        }
        const result = await context.core.workspace.importCheck(
          projectId,
          importOptions,
        );
        if (result.repaired.length > 0) {
          context.core.invalidate(context.projects.resolveProject(projectId));
        }
        return result;
      }),
  };
}
