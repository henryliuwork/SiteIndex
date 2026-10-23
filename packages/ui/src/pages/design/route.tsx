import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/design", "正在打开设计规范…", () => import("../DesignPage").then(({ DesignPage }) => ({ default: DesignPage })));
