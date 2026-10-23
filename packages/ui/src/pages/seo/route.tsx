import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/seo", "正在打开 SEO 页面…", () => import("../SeoPage").then(({ SeoPage }) => ({ default: SeoPage })));
