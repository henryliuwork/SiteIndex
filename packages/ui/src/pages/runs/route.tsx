import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/runs", "正在打开运行与定时任务…", () => import("../RunsPage").then(({ RunsPage }) => ({ default: RunsPage })));
