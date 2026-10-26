import type { SiteIndexApi } from "@siteindex/shared";
import { clone, mockSkillBodies, mockSkillTargets, mockSkills, reply } from "./context";

export function createSkillsMock(): SiteIndexApi["skills"] {
  return {
    list: () => reply(() => clone(mockSkills)),
    get: (name) => reply(() => {
      const info = mockSkills.find((skill) => skill.name === name);
      if (!info) throw new Error("找不到 Skill：" + name);
      return { info: clone(info), body: mockSkillBodies[name] ?? "# " + name + "\n\n请先阅读项目 README，再根据当前数据完成任务。" };
    }),
    targets: (name) => reply(() => clone(mockSkillTargets[name] ?? [])),
    install: (name, targetId) => reply(() => {
      const target = mockSkillTargets[name]?.find((item) => item.target_id === targetId);
      if (!target) throw new Error("找不到 Skill 安装位置：" + targetId);
      target.status = "latest";
      target.dir ??= "C:/SiteIndex/mock-skills/" + name;
      return clone(target);
    }),
    syncAllProjects: () => reply(() => {
      for (const targets of Object.values(mockSkillTargets)) {
        for (const target of targets) if (target.target_id.startsWith("project:")) target.status = "latest";
      }
    }),
  };
}
