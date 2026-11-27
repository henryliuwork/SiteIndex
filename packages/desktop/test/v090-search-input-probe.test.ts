import { describe, expect, it, vi } from "vitest";
import { probeSearchInput } from "../scripts/acceptance/search-input-probe.mjs";

function syntheticSearch() {
  let value = "";
  let focused = true;
  const input = {
    count: vi.fn(async () => 1),
    focus: vi.fn(async () => { focused = true; }),
    pressSequentially: vi.fn(async (text: string) => { value += text; }),
    inputValue: vi.fn(async () => value),
    evaluate: vi.fn(async () => focused),
  };
  const page = { getByRole: vi.fn(() => input) };
  return { page, input };
}

describe("v0.9.0 packaged search input probe", () => {
  it("uses an accessible searchbox and accepts refresh completion at all specified delays", async () => {
    for (const delay of [0, 300, 1000]) {
      const search = syntheticSearch();
      const started = Date.now();
      await probeSearchInput({ page: search.page, label: "搜索产品与 SKU",
        isQueryComplete: () => Date.now() - started >= delay,
        hasWholeTableLoading: async () => false, intervalMs: 5, timeoutMs: 1200 });
      expect(search.page.getByRole).toHaveBeenCalledWith("searchbox", { name: "搜索产品与 SKU" });
      expect(search.input.pressSequentially.mock.calls.map(([text]) => text)).toEqual(["a", "b", "c"]);
    }
  });

  it("classifies lost focus, lost text and whole-table loading as product assertions", async () => {
    for (const fault of ["focus", "value", "loading"] as const) {
      const search = syntheticSearch();
      if (fault === "focus") search.input.evaluate.mockResolvedValue(false);
      if (fault === "value") search.input.inputValue.mockResolvedValue("ab");
      const result = probeSearchInput({ page: search.page, label: "搜索内容",
        isQueryComplete: async () => true,
        hasWholeTableLoading: async () => fault === "loading", intervalMs: 1 });
      await expect(result).rejects.toMatchObject({ acceptanceStatus: "assertion_failed" });
    }
  });

  it("rejects missing observation hooks as harness errors", async () => {
    const search = syntheticSearch();
    await expect(probeSearchInput({ page: search.page, label: "搜索内容" } as never))
      .rejects.toThrow("refresh observers");
  });
});
