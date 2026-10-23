import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/products", "正在打开产品页…", () => import("../ProductsPage").then(({ ProductsPage }) => ({ default: ProductsPage })));
