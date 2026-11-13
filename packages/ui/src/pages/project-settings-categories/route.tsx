import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/settings/categories", "正在打开项目设置…", () => import("../ProjectSettingsConfigPage").then(({ ProjectSettingsConfigPage }) => ({ default: ProjectSettingsConfigPage })));
