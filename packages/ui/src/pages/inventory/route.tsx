import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/inventory", "正在打开产品与库存管理…", () => import("../ProductsPage").then(({ ProductsPage }) => ({ default: ProductsPage })));
