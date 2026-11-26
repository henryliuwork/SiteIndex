// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { InventorySummary, ListQuery, ProductFilters, ProductFull, ProductView, SkuStockFilters, SkuStockView } from "@siteindex/shared";
import { createMockApi } from "../mock";
import { formatInStockVariants, matchesFilteredStockRows, mergeProductAndStockRows } from "./products/merged-rows";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("si-table-scroll") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("si-table-scroll") || this.classList.contains("si-summary-line") ? 1200 : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

function makeProduct(overrides: Partial<ProductView> & Pick<ProductView, "handle" | "title">): ProductView {
  const { handle, title, ...rest } = overrides;
  return {
    handle,
    product_id: "demo-product-" + handle,
    title,
    url: "https://demo-store.example.test/products/" + handle,
    category: "演示分类",
    categories: ["演示分类"],
    price_min: 24,
    price_max: 24,
    compare_at_max: null,
    currency: "USD",
    on_sale: false,
    image_url: null,
    image_source: "none",
    feed_image_url: null,
    manual_image_url: null,
    variant_count: null,
    skus: [],
    in_stock_variants: null,
    row_kind: "single",
    parent_sku: null,
    stock_status: "in_stock",
    stock_since: "2026-11-01",
    tags: [],
    priority: null,
    exclude_edm: 0,
    email_blurb: null,
    last_featured: null,
    days_since_featured: null,
    is_new: false,
    restocked_at: null,
    price_dropped_at: null,
    first_seen: "2026-11-01",
    status: "active",
    ...rest,
  };
}

function makeStock(sku: string, price: number, overrides: Partial<SkuStockView> = {}): SkuStockView {
  return {
    sku,
    title: "虚构组合商品",
    variant_title: "虚构款式",
    category: "演示分类",
    price,
    stock_status: "in_stock",
    since: "2026-11-01",
    days_in_status: 5,
    online_rate_7d: 1,
    online_rate_30d: 0.8,
    history_30d: "i".repeat(30),
    changes_30d: 2,
    last_change: "stock_change",
    last_change_at: "2026-11-12",
    parent_sku: null,
    price_history: [
      { date: "2026-11-10", price: price - 2 },
      { date: "2026-11-12", price },
    ],
    ...overrides,
  };
}

const parent = makeProduct({
  handle: "demo-family",
  title: "虚构组合商品",
  product_id: "DEMO001A",
  row_kind: "parent",
  price_min: 20,
  price_max: 40,
  variant_count: 2,
  in_stock_variants: 1,
  skus: ["DEMO001A01", "DEMO001A02"],
  rating: 4.8,
  review_count: 23,
});
const child = makeProduct({
  handle: "demo-family-child",
  title: "虚构组合商品子款",
  product_id: "demo-child-product",
  row_kind: "child",
  parent_sku: "DEMO001A",
  price_min: 27,
  price_max: 27,
  variant_count: null,
  in_stock_variants: null,
  skus: ["DEMO001A01"],
});
const parentStock = makeStock("DEMO001A", 20, { is_parent: true, children_count: 2, in_stock_children_count: 1 });
const childStocks = [
  makeStock("DEMO001A01", 27, { parent_sku: "DEMO001A", variant_title: "蓝色款" }),
  makeStock("DEMO001A02", 40, { parent_sku: "DEMO001A", stock_status: "out_of_stock", online_rate_30d: null, variant_title: "绿色款" }),
];
const productManagement: NonNullable<InventorySummary["product_management"]> = {
  as_of: "2026-11-12", total_rows: 1, in_stock_rows: 1, online_rate: 1,
  changed_rows: 1, out_of_stock_7d_rows: 0, fluctuating_30d_rows: 0,
};

async function renderProductsPage(options: {
  products?: ProductView[];
  parentStocks?: SkuStockView[];
  stockRows?: SkuStockView[];
  detail?: ProductFull;
  groupingEnabled?: boolean;
  feedlessCollection?: boolean;
  syncAt?: string;
  initialPath?: string;
  productManagement?: InventorySummary["product_management"];
  metricRows?: Partial<Record<NonNullable<SkuStockFilters["summary_metric"]>, SkuStockView[]>>;
} = {}) {
  const products = options.products ?? [parent, child];
  const parentStocks = options.parentStocks ?? [parentStock];
  const stockRows = options.stockRows ?? [parentStock, ...childStocks];
  const mockApi = createMockApi();
  const project = await mockApi.projects.get("demo");
  const originalSummary = mockApi.inventory.summary;
  mockApi.inventory.summary = vi.fn(async (id, range) => ({ ...await originalSummary(id, range), product_management: options.productManagement }));
  mockApi.projects.get = vi.fn(async () => ({
    ...project,
    summary: options.syncAt
      ? { ...project.summary, sync: { ...project.summary.sync, state: "ok" as const, at: options.syncAt } }
      : project.summary,
    config: {
      ...project.config,
      crawl: options.feedlessCollection ? { ...project.config.crawl, feed_url: "", auto_collect_products: true } : project.config.crawl,
      sku_grouping: { enabled: options.groupingEnabled !== false, rule: { type: "regex" as const, value: "^(.+?)\\d{2}$" } },
    },
  }));
  mockApi.products.list = vi.fn(async (_id: string, query: ListQuery<ProductFilters>) => {
    const rows = query.filters?.parent_only
      ? products.filter((product) => product.row_kind !== "child")
      : products.filter((product) => product.row_kind !== "parent");
    return { rows, total: rows.length };
  });
  mockApi.inventory.listSkus = vi.fn(async (_id: string, query: ListQuery<SkuStockFilters>) => {
    const rows = query.filters?.summary_metric ? options.metricRows?.[query.filters.summary_metric] ?? [] : query.filters?.parent_only ? parentStocks : stockRows;
    return { rows, total: rows.length };
  });
  if (options.detail) mockApi.products.get = vi.fn(async () => options.detail!);
  vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback, apiErrorDetails: () => null }));
  const [{ ToastProvider }, { ProductsPage }] = await Promise.all([import("../components"), import("./ProductsPage")]);
  const { route: inventoryRoute } = await import("./inventory/route");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function CurrentLocation() {
    const location = useLocation();
    return <output data-testid="current-location">{location.pathname}{location.search}{location.hash}</output>;
  }
  render(
    <ToastProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[options.initialPath ?? "/p/demo/products"]}>
          <Routes>
            <Route path={inventoryRoute.path} element={inventoryRoute.element} />
            <Route path="/p/:id/products" element={<><ProductsPage /><CurrentLocation /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
  return mockApi;
}

function findCell(row: HTMLElement, headerName: string): string | undefined {
  const table = row.closest("table");
  const headers = Array.from(table?.querySelectorAll("thead th") ?? []);
  const index = headers.findIndex((header) => header.textContent?.trim().includes(headerName));
  return index < 0 ? undefined : row.querySelectorAll("td")[index]?.textContent?.trim();
}

describe("合并后的产品管理表", () => {
  it("筛选弹层使用可见标签和共享复选框", async () => {
    const mockApi = await renderProductsPage();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    const dialog = await screen.findByRole("dialog", { name: "产品筛选" });
    for (const label of ["库存状态", "分类", "价格变动", "标签"]) {
      expect(within(dialog).getByText(label)).toBeTruthy();
    }
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "仅关注分类" }));
    await waitFor(() => expect(mockApi.inventory.listSkus).toHaveBeenLastCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ watched_only: true }),
    })));
  });

  it("整列无值时默认隐藏并在列设置标注无数据，真实值不被标空", async () => {
    const empty = makeProduct({ handle: "demo-empty", title: "虚构无指标商品", product_id: "DEMOEMPTY", price_min: null, price_max: null, skus: ["DEMOEMPTY"] });
    await renderProductsPage({ products: [empty], parentStocks: [] });
    const table = await screen.findByRole("table");
    await within(table).findByText("虚构无指标商品", { selector: "strong" });
    expect(within(table).queryByRole("columnheader", { name: "有货变体" })).toBeNull();
    expect(within(table).queryByRole("columnheader", { name: "30 天在线率" })).toBeNull();
    expect(within(table).queryByRole("columnheader", { name: "价格" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    for (const label of ["有货变体 · 无数据", "30 天在线率 · 无数据", "价格 · 无数据", "最近变化 · 无数据", "评分 / 评价数 · 无数据"]) {
      expect(await screen.findByRole("checkbox", { name: label })).toBeTruthy();
    }
  });

  it("在线率与价格有真实值时不标记为无数据", async () => {
    await renderProductsPage();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    expect(screen.queryByRole("checkbox", { name: "30 天在线率 · 无数据" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "价格 · 无数据" })).toBeNull();
  });

  it("五个非自明表头显示与 Core 口径一致的说明", async () => {
    await renderProductsPage();
    const table = await screen.findByRole("table");
    await within(table).findByText("虚构组合商品", { selector: "strong" });
    expect(within(table).getByRole("button", { name: "30 天在线率说明" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    for (const name of ["持续", "近 30 天趋势", "最近变化", "评分 / 评价数"]) {
      fireEvent.click(await screen.findByRole("checkbox", { name }));
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    for (const name of ["持续", "近 30 天趋势", "最近变化", "评分 / 评价数"]) {
      expect(within(table).getByRole("button", { name: `${name}说明` })).toBeTruthy();
    }
  });
  it("使用项目表格外框，项目头不重复显示站点和同步时间", async () => {
    await renderProductsPage({ syncAt: "2026-11-12T10:00:00Z" });
    expect(await screen.findByRole("table")).toBeTruthy();
    const frame = document.querySelector(".si-page-frame-project.is-table");
    const header = frame?.querySelector(".si-page-frame-header .si-project-header-single");
    expect(header).toBeTruthy();
    expect(header?.textContent).not.toContain("demo-store.example.test");
    expect(header?.textContent).not.toContain("2026-11-12");
    expect(frame?.querySelector(".si-page-frame-body .si-products-page .si-tab-panel")).toBeTruthy();
  });

  it("摘要只使用真实契约字段；字段缺失或无业务日时显示明确空态", async () => {
    await renderProductsPage();
    expect(await screen.findByText("当前运行环境未提供产品管理摘要。")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "产品管理摘要" })).toBeNull();
  });

  it("没有业务日期时不展示摘要计数", async () => {
    await renderProductsPage({ productManagement: { ...productManagement, as_of: null } });
    expect(await screen.findByText("尚无产品管理业务日期，摘要暂不可用。")).toBeTruthy();
  });

  it("摘要点击请求 Core 同语义库存行、清理旧筛选，再点取消并同步 URL", async () => {
    const mockApi = await renderProductsPage({ productManagement, metricRows: { changed: [parentStock] } });
    expect(await screen.findByRole("group", { name: "产品管理摘要" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /今日变化/ }));
    await waitFor(() => expect(mockApi.inventory.listSkus).toHaveBeenLastCalledWith("demo", expect.objectContaining({ filters: expect.objectContaining({ parent_only: true, summary_metric: "changed", status: undefined }) })));
    expect(screen.getByTestId("current-location").textContent).toContain("summary_metric=changed");
    expect(within(screen.getByRole("group", { name: "产品管理摘要" })).getByRole("button", { name: /今日变化/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(screen.getByRole("group", { name: "产品管理摘要" })).getByRole("button", { name: /今日变化/ }));
    await waitFor(() => expect(screen.getByTestId("current-location").textContent).toBe("/p/demo/products"));
  });

  it("摘要深链刷新后恢复筛选，缺失或重复产品行时不显示错误结果", async () => {
    const mockApi = await renderProductsPage({ productManagement, metricRows: { in_stock: [parentStock] }, initialPath: "/p/demo/products?summary_metric=in_stock" });
    await waitFor(() => expect(mockApi.inventory.listSkus).toHaveBeenCalledWith("demo", expect.objectContaining({ filters: expect.objectContaining({ parent_only: true, summary_metric: "in_stock" }) })));
    expect(within(await screen.findByRole("group", { name: "产品管理摘要" })).getByRole("button", { name: /在线率/ }).getAttribute("aria-pressed")).toBe("true");
    expect(matchesFilteredStockRows(mergeProductAndStockRows([parent, parent], [parentStock], true), [parentStock])).toBe(false);
  });

  it("缺失产品行时不展示错误的库存筛选结果", async () => {
    await renderProductsPage({ productManagement, metricRows: { in_stock: [parentStock, makeStock("DEMO-MISSING", 18)] }, initialPath: "/p/demo/products?summary_metric=in_stock" });
    expect(await screen.findByText("产品与库存行尚未对齐")).toBeTruthy();
  });

  it("从摘要进入后搜索时不把本地搜索结果误报为库存行不一致", async () => {
    await renderProductsPage({ productManagement, metricRows: { in_stock: [parentStock] }, initialPath: "/p/demo/products?summary_metric=in_stock" });
    await screen.findByRole("group", { name: "产品管理摘要" });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索产品与 SKU" }), { target: { value: "不存在的虚构商品" } });
    expect(await screen.findByText("没有匹配的产品或 SKU")).toBeTruthy();
    expect(screen.queryByText("产品与库存行尚未对齐")).toBeNull();
  });

  it("历史不足的摘要项不显示虚构 0", async () => {
    await renderProductsPage({ productManagement: { ...productManagement, out_of_stock_7d_rows: null, fluctuating_30d_rows: null } });
    expect(await screen.findByText("历史数据不足，部分摘要指标暂不可用。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /长期缺货/ })).toBeNull();
  });
  it("无 Feed 自动采集已配置时不提示商品来源未配置", async () => {
    await renderProductsPage({ feedlessCollection: true });
    expect(await screen.findByText("无 Feed 自动采集已启用")).toBeTruthy();
    expect(screen.getByText("首次及每日同步优先使用 WooCommerce Store API；失败时回退商品 Sitemap/HTML。")).toBeTruthy();
    expect(screen.queryByText(/未配置商品来源|每日库存同步未启用/)).toBeNull();
  }, 15_000);

  it("项目头不重复显示侧栏已有的同步时间", async () => {
    await renderProductsPage({ syncAt: new Date(2026, 10, 8, 17, 0).toISOString() });

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(document.querySelector(".si-project-header-sync")).toBeNull();
    expect(screen.queryByText(/最近同步|11-08 17:00/)).toBeNull();
    expect(screen.queryByText(/今天/)).toBeNull();
  }, 15_000);

  it("保留旧库存路径重定向到合并后的产品管理页", async () => {
    await renderProductsPage({ initialPath: "/p/demo/inventory?stock=out_of_stock#sku-42" });

    expect((await screen.findByTestId("current-location")).textContent).toBe("/p/demo/products?stock=out_of_stock#sku-42");
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("默认仅显示父 SKU，切换后显示子 SKU", async () => {
    const mockApi = await renderProductsPage();
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers[0]?.textContent).toContain("SKU");
    expect(headers[0]?.classList.contains("is-sticky-left")).toBe(true);
    expect(headers[0]?.style.left).toBe("0px");
    expect(headers[1]?.textContent).toContain("产品名称");
    expect(headers[1]?.classList.contains("is-sticky-left")).toBe(true);
    await within(table).findByText("虚构组合商品", { selector: "strong" });
    const parentRow = screen.getByText("虚构组合商品", { selector: "strong" }).closest("tr")!;
    expect(parentRow.querySelector(".si-product-sku")?.textContent).toBe("DEMO001A");
    expect(parentRow.querySelector("td:first-child .si-product-sku")?.textContent).toBe("DEMO001A");
    expect(parentRow.querySelector("td:first-child")?.classList.contains("is-sticky-left")).toBe(true);
    expect(parentRow.querySelector("td:first-child")?.getAttribute("style")).toContain("left: 0px");
    expect(parentRow.querySelector("td:nth-child(2)")?.classList.contains("is-sticky-left")).toBe(true);
    expect(parentRow.querySelector("td:nth-child(2)")?.getAttribute("style")).toContain("left:");
    expect(parentRow.querySelector(".si-product-main-copy")?.textContent).toBe("虚构组合商品");
    expect(parentRow.querySelector(".si-product-main-copy strong")?.getAttribute("title")).toBe("虚构组合商品");
    expect(parentRow.querySelector(".si-product-main-copy code, .si-product-main-copy .si-chip")).toBeNull();
    expect(parentRow.querySelector("td:nth-child(2)")?.textContent).not.toContain("DEMO001A");
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    expect(screen.getByRole("checkbox", { name: "SKU" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "产品名称" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(within(table).queryByText("虚构组合商品子款", { selector: "strong" })).toBeNull();
    expect(screen.getByRole("group", { name: "SKU 展示模式" })).toBeTruthy();
    expect(mockApi.products.list).toHaveBeenCalledWith("demo", expect.objectContaining({ filters: expect.objectContaining({ parent_only: true }) }));

    fireEvent.click(screen.getByRole("button", { name: "显示子 SKU" }));
    await within(table).findByText("虚构组合商品子款", { selector: "strong" });
    const childRow = screen.getByText("虚构组合商品子款", { selector: "strong" }).closest("tr")!;
    expect(childRow.querySelector("td:first-child .si-product-sku.is-child")?.textContent).toBe("DEMO001A01");
    expect(childRow.querySelector("td:first-child")?.classList.contains("is-sticky-left")).toBe(true);
    expect(childRow.querySelector("td:first-child")?.getAttribute("style")).toContain("left: 0px");
    expect(childRow.querySelector("td:nth-child(2)")?.textContent).not.toContain("DEMO001A01");
    await waitFor(() => expect(mockApi.products.list).toHaveBeenLastCalledWith("demo", expect.objectContaining({ filters: expect.objectContaining({ parent_only: undefined }) })));
  });

  it("已下架归入库存状态列，名称列仍只显示图片与名称", async () => {
    const removed = makeProduct({ handle: "demo-removed", title: "虚构下架商品", product_id: "DEMOREMOVED", skus: ["DEMOREMOVED"], status: "removed" });
    await renderProductsPage({ products: [removed], parentStocks: [], stockRows: [] });
    const table = await screen.findByRole("table");
    const row = (await within(table).findByText("虚构下架商品", { selector: "strong" })).closest("tr")!;
    expect(findCell(row, "库存状态")).toBe("已下架");
    expect(row.querySelector(".si-product-main-copy")?.textContent).toBe("虚构下架商品");
  });

  it("各列按内容对齐，链接和操作列保持紧凑固定宽度", async () => {
    await renderProductsPage();
    const table = await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    for (const name of ["持续", "近 30 天趋势", "分类", "最近变化", "评分 / 评价数", "链接"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: name }));
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const headers = within(table).getAllByRole("columnheader");
    const cells = (await within(table).findByText("虚构组合商品", { selector: "strong" })).closest("tr")!.querySelectorAll("td");
    for (const name of ["SKU", "产品名称", "库存状态", "近 30 天趋势", "分类", "最近变化"]) {
      const index = headers.findIndex((header) => header.textContent?.includes(name));
      expect(headers[index]?.style.textAlign).toBe("left");
      expect(cells[index]?.style.textAlign).toBe("left");
    }
    for (const name of ["持续", "30 天在线率", "有货变体", "价格", "评分 / 评价数"]) {
      const index = headers.findIndex((header) => header.textContent?.includes(name));
      expect(headers[index]?.style.textAlign).toBe("right");
      expect(cells[index]?.style.textAlign).toBe("right");
    }
    for (const name of ["链接", "操作"]) {
      const index = headers.findIndex((header) => header.textContent?.includes(name));
      expect(headers[index]?.style.textAlign).toBe("center");
      expect(cells[index]?.style.textAlign).toBe("center");
    }
    const tableWidth = Number.parseFloat(table.style.width);
    const widths = [...table.querySelectorAll("colgroup col")].map((column) => Number.parseFloat((column as HTMLTableColElement).style.width) * tableWidth / 100);
    expect(widths[headers.findIndex((header) => header.textContent?.includes("近 30 天趋势"))]).toBeGreaterThanOrEqual(202);
    expect(widths[headers.findIndex((header) => header.textContent?.includes("链接"))]).toBeCloseTo(68);
    expect(widths[headers.findIndex((header) => header.textContent?.includes("操作"))]).toBeCloseTo(64);
  });

  it("开启 30 天趋势列时，父子行都在独立列显示比例和真实趋势", async () => {
    await renderProductsPage({
      parentStocks: [makeStock("DEMO001A", 20, { is_parent: true, online_rate_30d: 0.5, history_30d: "io".repeat(15) })],
      stockRows: [
        makeStock("DEMO001A", 20, { is_parent: true, online_rate_30d: 0.5, history_30d: "io".repeat(15) }),
        makeStock("DEMO001A01", 27, { parent_sku: "DEMO001A", online_rate_30d: 0.8, history_30d: "i".repeat(24) + "o".repeat(6) }),
      ],
    });
    const table = await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "近 30 天趋势" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const headers = within(table).getAllByRole("columnheader").map((header) => header.textContent?.trim());
    expect(headers.indexOf("近 30 天趋势")).toBe(headers.indexOf("30 天在线率") + 1);
    const parentRow = (await within(table).findByText("虚构组合商品", { selector: "strong" })).closest("tr")!;
    expect(findCell(parentRow, "30 天在线率")).toBe("50%");
    expect(parentRow.querySelector(".si-status-cells")?.getAttribute("aria-label")).toContain("有货、缺货");
    expect(parentRow.querySelectorAll(".si-status-cells svg rect")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "显示子 SKU" }));
    const childRow = (await within(table).findByText("虚构组合商品子款", { selector: "strong" })).closest("tr")!;
    expect(findCell(childRow, "30 天在线率")).toBe("80%");
    expect(childRow.querySelector(".si-status-cells")?.getAttribute("aria-label")).toContain("有货、缺货");
  });

  it("链接列仅显示有提示的图标按钮，并打开对应商品页", async () => {
    const mockApi = await renderProductsPage();
    mockApi.shell.openExternal = vi.fn().mockResolvedValue(undefined);
    const table = await screen.findByRole("table");
    await within(table).findByText("虚构组合商品", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "链接" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const button = await within(table).findByRole("button", { name: "打开 虚构组合商品 商品页" });
    expect(button.getAttribute("title")).toBe("打开 虚构组合商品 商品页");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    await waitFor(() => expect(mockApi.shell.openExternal).toHaveBeenCalledWith(parent.url));
  });

  it("父 SKU 价格显示范围，子 SKU 显示自己的价格且只在父行显示有货变体数", async () => {
    await renderProductsPage();
    const table = await screen.findByRole("table");
    const parentRow = (await within(table).findByText("虚构组合商品", { selector: "strong" })).closest("tr")!;
    expect(findCell(parentRow, "价格")).toBe("20.00–40.00");
    expect(findCell(parentRow, "有货变体")).toBe("1/2");
    expect(findCell(parentRow, "评分 / 评价数")).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "评分 / 评价数" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "最近变化" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(findCell(parentRow, "评分 / 评价数")).toBe("4.8 · 23"));
    expect(findCell(parentRow, "最近变化")).toContain("stock_change");
    expect(within(table).queryByText("30 天销量")).toBeNull();
    expect(within(table).queryByText("30 天销售额")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "显示子 SKU" }));
    const childRow = (await within(table).findByText("虚构组合商品子款", { selector: "strong" })).closest("tr")!;
    expect(findCell(childRow, "价格")).toBe("27.00");
    expect(findCell(childRow, "有货变体")).toBe("—");
  });

  it("缺少任一产品变体计数时显示破折号，不拿 SKU 分组数代替", () => {
    const missingVariantCount = makeProduct({ handle: "demo-missing-count", title: "虚构缺少计数产品", row_kind: "parent", variant_count: null, in_stock_variants: 2 });
    const missingStockCount = makeProduct({ handle: "demo-missing-stock", title: "虚构缺少有货计数产品", row_kind: "parent", variant_count: 3, in_stock_variants: null });
    const base = { id: "test", sku: "DEMO001A", stock: parentStock };
    expect(formatInStockVariants({ ...base, product: parent, kind: "parent" })).toBe("1/2");
    expect(formatInStockVariants({ ...base, product: missingVariantCount, kind: "parent" })).toBe("—");
    expect(formatInStockVariants({ ...base, product: missingStockCount, kind: "parent" })).toBe("—");
    expect(formatInStockVariants({ ...base, product: parent, kind: "child" })).toBe("—");
  });

  it("行详情使用共享分段并可切换概况、变体库存和历史", async () => {
    const variants = childStocks.map((stock) => ({
      sku: stock.sku,
      title: stock.variant_title ?? "虚构款式",
      stock_status: stock.stock_status,
      since: stock.since,
      days_in_status: stock.days_in_status,
      price: stock.price,
      history_30d: stock.history_30d,
      online_rate_30d: stock.online_rate_30d,
    }));
    const detail: ProductFull = { product: parent, skus: [], details: null, seo: null, variants };
    await renderProductsPage({ detail });
    const table = await screen.findByRole("table");
    await within(table).findByText("虚构组合商品", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "查看 DEMO001A 详情" }));

    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByRole("heading", { name: "SEO 与 Google 收录" });
    expect(within(drawer).getByRole("group", { name: "产品详情分段" })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "变体库存" }));
    expect(await within(drawer).findByRole("heading", { name: "变体库存 · 2 个" })).toBeTruthy();
    const variantTable = within(drawer).getByRole("table");
    expect(within(variantTable).getAllByRole("columnheader")[0]?.classList.contains("is-sticky-left")).toBe(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "历史" }));
    expect(await within(drawer).findByRole("heading", { name: "子 SKU 价格历史" })).toBeTruthy();
    expect(within(drawer).getByRole("combobox", { name: "价格历史 SKU" })).toBeTruthy();
  });

  it("保留趋势抽屉，并把今日日报与标签管理收在更多菜单", async () => {
    await renderProductsPage();
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "趋势与分类在线率" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "导出 CSV" })).toBeTruthy();
    expect(await screen.findByRole("menuitem", { name: "查看今日日报" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "标签管理" })).toBeTruthy();
  });

  it("分组未启用时只显示一份提示，规则预览仍有单独入口", async () => {
    await renderProductsPage({ groupingEnabled: false });
    expect(await screen.findByText("父 SKU 分组尚未启用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "SKU 父子规则预览与设置" }));
    expect(await screen.findByRole("dialog", { name: "SKU 父子规则预览" })).toBeTruthy();
    expect(screen.getAllByText("父 SKU 分组尚未启用")).toHaveLength(1);
  });

  it("只读场景在方法缺失或待接线时隐藏入口", async () => {
    const detail: ProductFull = { product: parent, skus: [], details: null, seo: null, variants: [] };
    const mockApi = await renderProductsPage({ detail });
    const { productScenarioOptions } = await import("./products/drawer/scenario-sections");
    expect(productScenarioOptions(mockApi.products, false, "DEMO001A", ["products.changes", "products.skuBrief", "products.groupFamily"])).toEqual([]);
    expect(productScenarioOptions(mockApi.products, false, null, [])).toEqual([]);
    delete mockApi.products.groupFamily;
    fireEvent.click(await screen.findByRole("button", { name: "查看 DEMO001A 详情" }));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("button", { name: "变更记录" })).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "父子归并建议" })).toBeNull();
  }, 15_000);

  it("变更记录加载与空态、SKU 简报错误重试可用", async () => {
    const detail: ProductFull = { product: parent, skus: [], details: null, seo: null, variants: [] };
    const mockApi = await renderProductsPage({ detail });
    let finish!: (value: Awaited<ReturnType<NonNullable<typeof mockApi.products.changes>>>) => void;
    mockApi.products.changes = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<typeof mockApi.products.changes>>>>((resolve) => { finish = resolve; }));
    mockApi.products.skuBrief = vi.fn().mockRejectedValueOnce(new Error("演示查询失败")).mockResolvedValue({
      data: null, metadata: { sources: [], collected_at: null, missing_fields: ["sku"], quality: "partial", anomalies: [] },
    });
    mockApi.products.groupFamily = vi.fn(async () => ({
      data: { sku: "DEMO001A", role: "parent" as const, parent_sku: null, child_skus: ["DEMO001A01"], collision: null },
      metadata: { sources: [], collected_at: null, missing_fields: [], quality: "complete" as const, anomalies: [] },
    }));
    fireEvent.click(await screen.findByRole("button", { name: "查看 DEMO001A 详情" }));
    const drawer = await screen.findByRole("dialog");
    fireEvent.click(await within(drawer).findByRole("button", { name: "变更记录" }));
    expect(within(drawer).getByRole("status").textContent).toContain("正在加载查询结果");
    finish({ data: [], metadata: { sources: [], collected_at: null, missing_fields: [], quality: "complete", anomalies: [] } });
    expect(await within(drawer).findByText("此 SKU 暂无变更记录。")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "SKU 简报" }));
    expect(await within(drawer).findByText("查询失败。")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "重试" }));
    expect(await within(drawer).findByText("没有这条 SKU 的简报。")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "父子归并建议" }));
    expect(await within(drawer).findByText("关联子 SKU：1 个")).toBeTruthy();
  }, 15_000);
});
