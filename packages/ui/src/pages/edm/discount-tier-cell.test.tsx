// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkuImageRow } from "@siteindex/shared";
import { api } from "../../api";
import { ToastProvider } from "../../components";
import { EdmDiscountTierCell } from "./discount-tier-cell";

vi.mock("../../api", () => ({
  api: { edm: { setDiscountTier: vi.fn() } },
  apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const setDiscountTier = vi.mocked(api.edm.setDiscountTier!);
const capability = { available: true, message: "" };

function row(sku: string, discount_tier: number | null): SkuImageRow {
  return {
    sku, title: "虚构演示商品 " + sku, variant_title: null, stock_status: "in_stock",
    feed_image_url: null, manual_image_url: null, used: "none", discount_tier,
  };
}

beforeEach(() => {
  setDiscountTier.mockReset();
  setDiscountTier.mockImplementation(async (_projectId, sku, discount_tier) => ({ sku, discount_tier }));
});

afterEach(() => cleanup());

describe("EdmDiscountTierCell", () => {
  it("逐 SKU 保存选择、保持空白并允许清除", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    render(<ToastProvider><QueryClientProvider client={queryClient}>
      <EdmDiscountTierCell projectId="demo" row={row("DEMO-DISCOUNT-001", null)} tiers={[10, 20]} capability={capability} />
      <EdmDiscountTierCell projectId="demo" row={row("DEMO-DISCOUNT-002", 10)} tiers={[10, 20]} capability={capability} />
    </QueryClientProvider></ToastProvider>);
    const first = screen.getByRole("combobox", { name: "DEMO-DISCOUNT-001 折扣档位" });
    const second = screen.getByRole("combobox", { name: "DEMO-DISCOUNT-002 折扣档位" });
    expect(first.textContent).toBe("未选择");
    expect(second.textContent).toBe("10%");

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("option", { name: "20%" }));
    await waitFor(() => expect(setDiscountTier).toHaveBeenCalledWith("demo", "DEMO-DISCOUNT-001", 20));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["edm", "images", "demo"] }));

    fireEvent.click(second);
    fireEvent.click(screen.getByRole("option", { name: "清除选择" }));
    await waitFor(() => expect(setDiscountTier).toHaveBeenCalledWith("demo", "DEMO-DISCOUNT-002", null));
  });

  it("后端未就绪时继续显示现有值但不允许修改", () => {
    render(<ToastProvider><QueryClientProvider client={new QueryClient()}>
      <EdmDiscountTierCell projectId="demo" row={row("DEMO-DISCOUNT-LOCKED", 15)} tiers={[10, 15, 20]} capability={{ available: false, message: "尚未就绪" }} />
    </QueryClientProvider></ToastProvider>);
    const select = screen.getByRole("combobox", { name: "DEMO-DISCOUNT-LOCKED 折扣档位" });
    expect(select.textContent).toBe("15%");
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(setDiscountTier).not.toHaveBeenCalled();
  });
});
