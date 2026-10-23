import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/readme", "正在打开 README…", () => import("../ReadmePage").then(({ ReadmePage }) => ({ default: ReadmePage })));
