// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterBar } from "../../components";
import { SeoMultiFilter, SeoSingleFilter } from "./filters";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SEO 筛选下拉", () => {
  it("问题类型支持搜索、计数复选和清除", () => {
    const onChange = vi.fn();
    render(<FilterBar><SeoMultiFilter label="问题类型" values={[]} options={[
      { value: "desc_duplicate", label: "Description 重复", count: 4 },
      { value: "schema_missing", label: "Schema 缺失", count: 2 },
    ]} onChange={onChange} /></FilterBar>);

    fireEvent.click(screen.getByRole("button", { name: "问题类型 · 已选 0" }));
    expect(screen.getByText("4")).toBeTruthy();
    expect(document.querySelector(".si-filter-bar")?.contains(screen.getByRole("group", { name: "问题类型" }))).toBe(false);
    const search = screen.getByRole("searchbox", { name: "搜索问题类型" });
    fireEvent.change(search, { target: { value: "schema" } });
    expect(screen.queryByText("Description 重复")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith(["schema_missing"]);
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("单选下拉选择严重级别", () => {
    const onChange = vi.fn();
    render(<SeoSingleFilter label="严重级别" value="all" options={[
      { value: "all", label: "全部" }, { value: "high", label: "高" },
    ]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "严重级别：全部" }));
    fireEvent.click(screen.getByRole("button", { name: "高" }));
    expect(onChange).toHaveBeenCalledWith("high");
  });
});
