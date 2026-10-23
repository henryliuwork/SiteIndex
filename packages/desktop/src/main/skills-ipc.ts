import type { SkillService } from "./skill-service.js";
import type { IpcHandlerImplementations } from "./ipc-registry.js";

export function createSkillIpcHandlers(skills: SkillService): IpcHandlerImplementations {
  return {
    "skills.list": () => skills.list(),
    "skills.get": (name) => skills.get(name as string),
    "skills.targets": (name) => skills.targets(name as string),
    "skills.install": (name, targetId) => skills.install(name as string, targetId as string),
    "skills.syncAllProjects": () => skills.syncAllProjects(),
  };
}
