import type { IpcHandlerImplementations } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";

export function createSkillsHandlers(context: IpcContext): IpcHandlerImplementations {
  return {
    "skills.list": () => context.skills.list(),
    "skills.get": (name) => context.skills.get(name as string),
    "skills.targets": (name) => context.skills.targets(name as string),
    "skills.install": (name, targetId) => context.skills.install(name as string, targetId as string),
    "skills.syncAllProjects": () => context.skills.syncAllProjects(),
  };
}
