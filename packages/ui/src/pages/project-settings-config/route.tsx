import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/settings/config", "正在打开项目配置…", () => import("../ProjectSettingsConfigPage").then(({ ProjectSettingsConfigPage }) => ({ default: ProjectSettingsConfigPage })));
