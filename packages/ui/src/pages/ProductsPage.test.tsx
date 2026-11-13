// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ListQuery, ProductFilters, ProductFull, ProductVariantStock, ProductView, SkuRecord } from "@siteindex/shared";
import { createMockApi } from "../mock";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("si-table-scroll") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("si-table-scroll") ? 1200 : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.doUnmock("../components");
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

function tableCell(row: HTMLElement, columnName: string): string | undefined {
  const table = row.closest("table");
  const headers = Array.from(table?.querySelectorAll("thead th") ?? []);
  const index = headers.findIndex((header) => header.textContent?.trim().includes(columnName));
  return index < 0 ? undefined : row.querySelectorAll("td")[index]?.textContent?.trim();
}

async function renderProductsPage(options: {
  products?: ProductView[];
  groupingEnabled?: boolean;
  detail?: ProductFull;
  simulateDelayedPageSizeRestore?: boolean;
} = {}) {
  const mockApi = createMockApi();
  if (options.groupingEnabled) {
    const project = await mockApi.projects.get("demo");
    mockApi.projects.get = vi.fn(async () => ({
      ...project,
      config: {
        ...project.config,
        sku_grouping: { enabled: true, rule: { type: "regex" as const, value: "^(.+?)\\d{2}$" } },
      },
    }));
  }
  if (options.products) {
    mockApi.products.list = vi.fn(async (_id: string, query: ListQuery<ProductFilters>) => {
      const rows = query.filters?.parent_only
        ? options.products!.filter((product) => product.row_kind !== "child")
        : options.products!;
      return { rows, total: rows.length };
    });
  }
  if (options.detail) mockApi.products.get = vi.fn(async () => options.detail!);
  vi.doMock("../api", () => ({
    api: mockApi,
    isMockApi: true,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
  }));
  if (options.simulateDelayedPageSizeRestore) {
    let queuedQuery: ListQuery<ProductFilters> | undefined;
    let queuedOnQueryChange: ((query: ListQuery<ProductFilters>) => void) | undefined;
    vi.doMock("../components", async () => {
      const actual = await vi.importActual<typeof import("../components")>("../components");
      const TableWithDelayedPageSizeRestore = (props: {
        query: ListQuery<ProductFilters>;
        onQueryChange: (query: ListQuery<ProductFilters>) => void;
      }) => {
        if (!queuedOnQueryChange) {
          queuedQuery = props.query;
          queuedOnQueryChange = props.onQueryChange;
        }
        return <button type="button" onClick={() => {
          if (queuedQuery && queuedOnQueryChange) queuedOnQueryChange({ ...queuedQuery, page: 1, pageSize: 200 });
        }}>模拟延迟页长恢复</button>;
      };
      return { ...actual, DataTable: TableWithDelayedPageSizeRestore as typeof actual.DataTable };
    });
  }
  const { ToastProvider } = await import("../components");
  const { ProductsPage } = await import("./ProductsPage");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ToastProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/demo/products"]}>
          <Routes><Route path="/p/:id/products" element={<ProductsPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
  return mockApi;
}

describe("ProductsPage 页面操作区", () => {
  it("把导出与 SKU 规则操作放进项目页头，不渲染重复 PageHeader", async () => {
    await renderProductsPage();

    expect(await screen.findByRole("button", { name: "导出 CSV" })).toBeTruthy();
    expect(document.querySelector(".si-products-page > .si-tab-panel .si-page-header")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "SKU 父子规则设置" })).toBeTruthy();
  });

  it("在产品页打开库存趋势和分类在线率，并可按分类筛选产品", async () => {
    const mockApi = await renderProductsPage();
    const listSpy = vi.spyOn(mockApi.products, "list");
    const summarySpy = vi.spyOn(mockApi.inventory, "summary");

    fireEvent.click(await screen.findByRole("button", { name: "趋势与分类在线率" }));

    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("heading", { name: /分类在线率趋势/ })).toBeTruthy();
    expect(within(drawer).getByRole("heading", { name: "分类在线率" })).toBeTruthy();
    await waitFor(() => expect(summarySpy).toHaveBeenCalledWith("demo", 30));

    const categoryButton = drawer.querySelector<HTMLButtonElement>(".si-category-rate");
    expect(categoryButton).not.toBeNull();
    fireEvent.click(categoryButton!);

    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ category: expect.any(String) }),
    })));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ProductsPage 父 SKU 与变体库存交互", () => {
  const parent = makeProduct({
    handle: "demo-kit", title: "演示组合商品", row_kind: "parent", parent_sku: null,
    variant_count: 2, in_stock_variants: 1, skus: ["DEMO-KIT-01", "DEMO-KIT-02"],
  });
  const child = makeProduct({
    handle: "demo-kit-blue", title: "演示组合商品蓝色款", row_kind: "child", parent_sku: "DEMO-KIT",
    variant_count: null, in_stock_variants: null, skus: ["DEMO-KIT-01"],
  });
  const single = makeProduct({
    handle: "demo-accessory", title: "演示独立配件", row_kind: "single",
    variant_count: null, in_stock_variants: null, skus: ["DEMO-ACCESSORY"],
  });

  it("开启仅展示父 SKU 后隐藏子行、保留独立产品，并把筛选传给列表 IPC", async () => {
    const mockApi = await renderProductsPage({ products: [parent, child, single], groupingEnabled: true });
    await vi.waitFor(() => expect(mockApi.products.list).toHaveBeenCalled());
    expect(await screen.findByText("演示组合商品蓝色款")).toBeTruthy();

    fireEvent.click(await screen.findByRole("checkbox", { name: "仅展示父 SKU" }));

    await screen.findByText("演示独立配件");
    await waitFor(() => expect(mockApi.products.list).toHaveBeenLastCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ parent_only: true }),
    })));
    await waitFor(() => expect(screen.queryByText("演示组合商品蓝色款")).toBeNull());
  });

  it("页大小恢复回调晚于筛选变更到达时保留当前筛选", async () => {
    const mockApi = await renderProductsPage({ products: [parent, child, single], simulateDelayedPageSizeRestore: true });
    await waitFor(() => expect(mockApi.products.list).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "有货" }));
    await waitFor(() => expect(mockApi.products.list).toHaveBeenLastCalledWith("demo", expect.objectContaining({
      filters: expect.objectContaining({ stock: "in" }),
    })));

    fireEvent.click(screen.getByRole("button", { name: "模拟延迟页长恢复" }));
    await waitFor(() => expect(mockApi.products.list).toHaveBeenLastCalledWith("demo", expect.objectContaining({
      page: 1,
      pageSize: 200,
      filters: expect.objectContaining({ stock: "in" }),
    })));
  });

  it("父行显示有货变体数，子行与独立产品的空聚合值显示破折号", async () => {
    await renderProductsPage({ products: [parent, child, single] });

    const parentRow = (await screen.findByText("演示组合商品", { selector: "strong" })).closest("tr")!;
    const childRow = screen.getByText("演示组合商品蓝色款", { selector: "strong" }).closest("tr")!;
    const singleRow = screen.getByText("演示独立配件", { selector: "strong" }).closest("tr")!;

    expect(tableCell(parentRow, "有货变体")).toBe("1/2");
    expect(tableCell(childRow, "有货变体")).toBe("—");
    expect(tableCell(singleRow, "有货变体")).toBe("—");
  });

  it("只把 Core 标记 removed 的产品显示为已下架，active 缺货和旧数据不误标", async () => {
    const activeOutOfStock = makeProduct({
      handle: "demo-active-oos", title: "虚构在售商品", status: "active", stock_status: "out_of_stock",
    });
    const removed = makeProduct({
      handle: "demo-removed", title: "虚构已下架商品", status: "removed",
    });
    const legacyProduct = Object.fromEntries(
      Object.entries(makeProduct({ handle: "demo-legacy", title: "虚构旧数据商品" })).filter(([key]) => key !== "status"),
    ) as unknown as ProductView;
    await renderProductsPage({ products: [activeOutOfStock, removed, legacyProduct] });

    const activeRow = (await screen.findByText("虚构在售商品", { selector: "strong" })).closest("tr")!;
    const removedRow = screen.getByText("虚构已下架商品", { selector: "strong" }).closest("tr")!;
    const legacyRow = screen.getByText("虚构旧数据商品", { selector: "strong" }).closest("tr")!;
    expect(within(activeRow).getByText("缺货")).toBeTruthy();
    expect(within(activeRow).queryByText("已下架")).toBeNull();
    expect(within(removedRow).getByText("已下架")).toBeTruthy();
    expect(within(legacyRow).queryByText("已下架")).toBeNull();
  });

  it("点击产品行打开真实详情 Drawer 并显示 Core 返回的变体库存表", async () => {
    const variants: ProductVariantStock[] = [
      { sku: "DEMO-KIT-01", title: "蓝色款", stock_status: "in_stock", since: "2026-11-01", days_in_status: 4, price: 24, history_30d: "i".repeat(30), online_rate_30d: 0.8 },
      { sku: "DEMO-KIT-02", title: "绿色款", stock_status: "out_of_stock", since: "2026-11-02", days_in_status: 3, price: 24, history_30d: "o".repeat(30), online_rate_30d: null },
    ];
    const detail: ProductFull = { product: parent, skus: [], details: null, seo: null, variants };
    const mockApi = await renderProductsPage({ products: [parent], detail });

    const parentRow = (await screen.findByText("演示组合商品", { selector: "strong" })).closest("tr")!;
    fireEvent.click(parentRow);

    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("heading", { name: "变体库存" })).toBeTruthy();
    expect(within(drawer).getByRole("heading", { name: "演示组合商品", level: 3 })).toBeTruthy();
    expect(mockApi.products.get).toHaveBeenCalledWith("demo", "demo-kit");
    const inventoryTable = within(drawer).getByRole("table");
    expect(within(inventoryTable).getByText("DEMO-KIT-01")).toBeTruthy();
    expect(within(inventoryTable).getByText("DEMO-KIT-02")).toBeTruthy();
    expect(within(inventoryTable).getByText("80%")).toBeTruthy();
    expect(within(inventoryTable).getByText("—")).toBeTruthy();
    expect(within(inventoryTable).getByRole("img", { name: /DEMO-KIT-01近 30 天库存/ })).toBeTruthy();
  });

  it("在 SKU 详情中显示 Core 返回的下架状态和移除原因", async () => {
    const removedSkus: SkuRecord[] = [
      { sku: "DEMO-ACCESSORY-OLD", product_id: single.product_id, handle: single.handle, title: single.title, variant_title: "旧款 A", url: single.url, category: single.category, category_source: "feed", price: 24, compare_at_price: null, currency: "USD", image_url: null, status: "removed", removed_reason: "feed_absent_404", first_seen: "2026-10-01", last_seen: "2026-11-01", updated_at: "2026-11-02" },
      { sku: "DEMO-ACCESSORY-AGED", product_id: single.product_id, handle: single.handle, title: single.title, variant_title: "旧款 B", url: single.url, category: single.category, category_source: "feed", price: 24, compare_at_price: null, currency: "USD", image_url: null, status: "removed", removed_reason: "feed_absent_aged", first_seen: "2026-10-01", last_seen: "2026-11-01", updated_at: "2026-11-02" },
    ];
    const detail: ProductFull = { product: single, skus: removedSkus, details: null, seo: null };
    await renderProductsPage({ products: [single], detail });

    fireEvent.click((await screen.findByText("演示独立配件", { selector: "strong" })).closest("tr")!);
    const drawer = await screen.findByRole("dialog");
    expect((await within(drawer).findAllByText("已下架")).length).toBe(2);
    expect(within(drawer).getByText("商品页不存在（404/410）")).toBeTruthy();
    expect(within(drawer).getByText("连续多次未见于 Feed")).toBeTruthy();
  });
});
