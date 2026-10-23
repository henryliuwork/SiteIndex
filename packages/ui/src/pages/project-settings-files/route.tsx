import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/settings/files", "正在打开本地文件…", () => import("../ProjectSettingsFilesPage").then(({ ProjectSettingsFilesPage }) => ({ default: ProjectSettingsFilesPage })));
