import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/skills", "正在打开 Skill 中心…", () => import("../SkillsPage").then(({ SkillsPage }) => ({ default: SkillsPage })));
