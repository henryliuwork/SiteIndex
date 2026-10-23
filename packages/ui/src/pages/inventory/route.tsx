import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/inventory", "正在打开库存页…", () => import("../InventoryPage").then(({ InventoryPage }) => ({ default: InventoryPage })));
