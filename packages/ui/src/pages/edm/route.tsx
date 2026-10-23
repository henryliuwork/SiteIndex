import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/edm", "正在打开 EDM 页面…", () => import("../EdmPage").then(({ EdmPage }) => ({ default: EdmPage })));
