// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "../primitives";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("SearchInput G9.0-0 regression evidence", () => {
  it.fails("debounces a continuous abc input for 250ms at 0ms intervals", async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });

    for (const value of ["a", "ab", "abc"]) {
      fireEvent.change(input, { target: { value } });
    }

    await advance(249);
    expect(onSearch).not.toHaveBeenCalled();
    await advance(1);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenLastCalledWith("abc");
    expect(document.activeElement).toBe(input);
  });

  it.fails.each([300, 1000])("keeps the 250ms debounce and focus with %ims between characters", async (interval) => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });

    for (const value of ["a", "ab", "abc"]) {
      fireEvent.change(input, { target: { value } });
      await advance(249);
      expect(onSearch).not.toHaveBeenCalledWith(value);
      await advance(interval - 249);
      expect(onSearch).toHaveBeenLastCalledWith(value);
      expect(document.activeElement).toBe(input);
    }
  });

  it.fails("does not query intermediate IME composition text", async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "拼" } });
    await advance(300);
    expect(onSearch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "拼音" } });
    fireEvent.compositionEnd(input);
    await advance(250);
    expect(onSearch).toHaveBeenLastCalledWith("拼音");
    expect(document.activeElement).toBe(input);
  });

  it.fails("keeps the raw draft after the trimmed query is applied", async () => {
    vi.useFakeTimers();
    function ControlledSearch() {
      const [query, setQuery] = useState("");
      return <SearchInput value={query} onSearch={setQuery} label="搜索测试数据" />;
    }

    render(<ControlledSearch />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    fireEvent.change(input, { target: { value: " abc " } });
    await advance(250);

    expect((input as HTMLInputElement).value).toBe(" abc ");
    expect(document.activeElement).toBe(input);
  });

  it.fails("submits on Enter without waiting for the debounce", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("abc");
  });

  it.fails("applies a cleared search immediately", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="abc" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    fireEvent.change(input, { target: { value: "" } });

    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("");
  });
});
