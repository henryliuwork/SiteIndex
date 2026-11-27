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

describe("SearchInput v0.9 regressions", () => {
  it.each([0, 100])("debounces abc for 250ms at %ims input intervals", async (interval) => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();

    for (const [index, value] of ["a", "ab", "abc"].entries()) {
      fireEvent.change(input, { target: { value } });
      if (interval > 0 && index < 2) await advance(interval);
    }

    await advance(249);
    expect(onSearch).not.toHaveBeenCalled();
    await advance(1);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenLastCalledWith("abc");
    expect(document.activeElement).toBe(input);
  });

  it.each([300, 1000])("keeps the 250ms debounce and focus with %ims between characters", async (interval) => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();

    for (const value of ["a", "ab", "abc"]) {
      fireEvent.change(input, { target: { value } });
      await advance(249);
      expect(onSearch).not.toHaveBeenCalledWith(value);
      await advance(interval - 249);
      expect(onSearch).toHaveBeenLastCalledWith(value);
      expect(document.activeElement).toBe(input);
    }
  });

  it("does not query intermediate IME composition text", async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "拼" } });
    await advance(300);
    expect(onSearch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "拼音" } });
    fireEvent.compositionEnd(input);
    await advance(249);
    expect(onSearch).not.toHaveBeenCalled();
    await advance(250);
    expect(onSearch).toHaveBeenLastCalledWith("拼音");
    expect(document.activeElement).toBe(input);
  });

  it("keeps the raw draft after the trimmed query is applied", async () => {
    vi.useFakeTimers();
    function ControlledSearch() {
      const [query, setQuery] = useState("");
      return <SearchInput value={query} onSearch={setQuery} label="搜索测试数据" />;
    }

    render(<ControlledSearch />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();
    fireEvent.change(input, { target: { value: " abc " } });
    await advance(250);

    expect((input as HTMLInputElement).value).toBe(" abc ");
    expect(document.activeElement).toBe(input);
  });

  it("submits on Enter immediately and cancels the pending debounce", async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("abc");
    await advance(250);
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("applies a cleared search immediately and cancels pending text", async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput value="abc" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    fireEvent.change(input, { target: { value: "abcd" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("");
    await advance(250);
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("uses the latest callback without restarting the debounce", async () => {
    vi.useFakeTimers();
    const firstSearch = vi.fn();
    const latestSearch = vi.fn();
    const view = render(<SearchInput value="" onSearch={firstSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();
    fireEvent.change(input, { target: { value: "abc" } });

    view.rerender(<SearchInput value="" onSearch={latestSearch} label="搜索测试数据" />);
    await advance(250);

    expect(firstSearch).not.toHaveBeenCalled();
    expect(latestSearch).toHaveBeenCalledOnce();
    expect(latestSearch).toHaveBeenCalledWith("abc");
    expect(document.activeElement).toBe(input);
  });

  it("accepts an external controlled-value reset and cancels stale search", async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    const view = render(<SearchInput value="" onSearch={onSearch} label="搜索测试数据" />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();
    fireEvent.change(input, { target: { value: "draft" } });

    view.rerender(<SearchInput value="restored" onSearch={onSearch} label="搜索测试数据" />);
    expect((input as HTMLInputElement).value).toBe("restored");
    await advance(250);

    expect(onSearch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it.each([0, 300, 1000])("keeps the focused input mounted during a %ims result refresh", async (responseDelay) => {
    vi.useFakeTimers();
    function SearchPage() {
      const [query, setQuery] = useState("");
      const [resultState, setResultState] = useState("已加载");
      return <>
        <div data-testid="toolbar"><SearchInput value={query} onSearch={(next) => {
          setQuery(next);
          if (responseDelay === 0) setResultState("已更新");
          else {
            setResultState("正在更新");
            window.setTimeout(() => setResultState("已更新"), responseDelay);
          }
        }} label="搜索测试数据" /></div>
        <div role="table">{resultState}</div>
      </>;
    }

    render(<SearchPage />);
    const input = screen.getByRole("searchbox", { name: "搜索测试数据" });
    input.focus();
    for (const [index, value] of ["a", "ab", "abc"].entries()) {
      fireEvent.change(input, { target: { value } });
      if (index < 2) await advance(100);
    }
    await advance(249);
    expect(screen.getByRole("table").textContent).toBe("已加载");
    await advance(1);

    expect(screen.getByRole("searchbox", { name: "搜索测试数据" })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("table").textContent).toBe(responseDelay === 0 ? "已更新" : "正在更新");
    if (responseDelay > 0) {
      await advance(responseDelay);
      expect(screen.getByRole("table").textContent).toBe("已更新");
      expect(document.activeElement).toBe(input);
    }
  });
});
