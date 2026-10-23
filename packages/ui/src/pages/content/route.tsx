import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/content", "正在打开内容页…", () => import("../ContentPage").then(({ ContentPage }) => ({ default: ContentPage })));
