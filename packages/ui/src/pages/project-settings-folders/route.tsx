import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/settings/folders", "正在打开项目文件夹设置…", () => import("../ProjectSettingsFoldersPage").then(({ ProjectSettingsFoldersPage }) => ({ default: ProjectSettingsFoldersPage })));
