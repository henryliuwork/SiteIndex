// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterBar } from "../filter-bar";
import { Popover } from "../primitives";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rect(top: number, height: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 400, bottom: top + height, width: 400, height, toJSON: () => ({}) };
}

function installLayoutMetrics() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("si-filter-bar-items")) return rect(100, 120);
    const top = this.getAttribute("data-filter-top");
    const height = this.getAttribute("data-filter-height");
    if (top !== null && height !== null) return rect(100 + Number(top), Number(height));
    return rect(0, 30);
  });
  vi.stubGlobal("ResizeObserver", class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() { this.callback([], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  });
}

describe("FilterBar DOM behavior", () => {
  it("does not show a collapse toggle for one or two mixed-height rows", () => {
    installLayoutMetrics();
    render(<FilterBar>
      <div data-filter-top="0" data-filter-height="30">严重级别</div>
      <div data-filter-top="6" data-filter-height="17">问题类型</div>
      <div data-filter-top="40" data-filter-height="30">状态</div>
      <div data-filter-top="46" data-filter-height="17">范围</div>
    </FilterBar>);

    expect(screen.queryByRole("button", { name: "更多筛选" })).toBeNull();
  });

  it("collapses after two rows and portals dropdown content outside the clipped filter region", async () => {
    installLayoutMetrics();
    render(<FilterBar>
      <div data-filter-top="0" data-filter-height="30">
        <Popover trigger={<button type="button">严重级别</button>}>严重级别选项</Popover>
      </div>
      <div data-filter-top="6" data-filter-height="17">问题类型</div>
      <div data-filter-top="40" data-filter-height="30">状态</div>
      <div data-filter-top="46" data-filter-height="17">范围</div>
      <div data-filter-top="80" data-filter-height="30">更新时间</div>
    </FilterBar>);

    const toggle = screen.getByRole("button", { name: "更多筛选" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "严重级别" }));
    const popoverContent = await screen.findByText("严重级别选项");
    expect(document.querySelector(".si-filter-bar")?.contains(popoverContent)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "收起筛选" }));
    expect(screen.getByRole("button", { name: "更多筛选" }).getAttribute("aria-expanded")).toBe("false");
  });
});
