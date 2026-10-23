import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/skills", "正在读取 Skill 中心…", () => import("../SkillsPage").then(({ SkillsPage }) => ({ default: SkillsPage })));
