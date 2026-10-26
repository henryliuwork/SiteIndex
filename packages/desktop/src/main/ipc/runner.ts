import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createRunnerHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "runner.get": (id) => context.withProject(id, (projectId) => context.core.runner.get(projectId)),
  };
}
