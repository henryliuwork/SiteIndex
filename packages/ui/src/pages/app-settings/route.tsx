import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/settings", "正在打开软件设置…", () => import("../AppSettingsPage").then(({ AppSettingsPage }) => ({ default: AppSettingsPage })));
