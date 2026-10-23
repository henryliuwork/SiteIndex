import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id", "正在打开项目概览…", () => import("../OverviewPage").then(({ OverviewPage }) => ({ default: OverviewPage })));
