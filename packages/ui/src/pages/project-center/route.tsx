import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/", "正在打开项目中心…", () => import("../ProjectCenterPage").then(({ ProjectCenterPage }) => ({ default: ProjectCenterPage })));
