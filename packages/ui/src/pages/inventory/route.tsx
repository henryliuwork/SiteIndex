import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/inventory", "正在加载 SKU 库存明细…", () => import("../InventoryPage").then(({ InventoryPage }) => ({ default: InventoryPage })));
