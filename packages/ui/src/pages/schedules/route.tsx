import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/schedules", "正在加载定时任务…", () => import("../SchedulesPage").then(({ SchedulesPage }) => ({ default: SchedulesPage })));
