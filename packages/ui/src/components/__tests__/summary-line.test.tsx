// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryLine, type SummaryLineItem } from "../summary-line";

const onToggle = vi.fn();
let rootWidth = 1000;
const items: SummaryLineItem[] = [
  { id: "open", label: "待处理", value: 12, active: false, onToggle },
  { id: "new", label: "本次新增", value: 3, active: true, onToggle },
  { id: "missing", label: "未收录", value: 5, active: false, onToggle },
  { id: "fixed", label: "已修复", value: 8, active: false, onToggle },
];

beforeEach(() => {
  rootWidth = 1000;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("si-summary-line") ? rootWidth : 0;
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() { /* deterministic DOM sizing below */ }
    disconnect() { /* no-op */ }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); onToggle.mockReset(); });

describe("SummaryLine", () => {
  it("renders at most four actionable counts and toggles the selected filter", () => {
    render(<SummaryLine items={[...items, { id: "extra", label: "多余", value: 1, active: false, onToggle }]} timeNote="SEO 抓取于 11-18 10:30" />);
    expect(screen.getByRole("button", { name: "待处理12" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "本次新增3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "多余1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "待处理12" }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "数据来源时间" })).toBeTruthy();
  });

  it("moves overflowing items into a keyboard-reachable menu", async () => {
    rootWidth = 180;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-summary-measure-item") ? 90 : this.hasAttribute("data-summary-measure-more") ? 50 : 0;
      return { width, height: 28, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 28, toJSON: () => ({}) };
    });
    render(<SummaryLine items={items} />);
    const more = screen.getByRole("button", { name: "更多摘要项" });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByRole("button", { name: "本次新增3" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "本次新增3" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
