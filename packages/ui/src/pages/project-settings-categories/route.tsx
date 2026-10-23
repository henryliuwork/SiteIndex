import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/settings/categories", "正在打开分类设置…", () => import("../ProjectSettingsCategoriesPage").then(({ ProjectSettingsCategoriesPage }) => ({ default: ProjectSettingsCategoriesPage })));
