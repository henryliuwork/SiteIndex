import { describe, expect, it } from "vitest";
import { readOverviewPanelsExpanded, saveOverviewPanelsExpanded } from "./overview-panels";

describe("库存概览面板状态", () => {
  it("按项目保存展开状态", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(readOverviewPanelsExpanded("demo", storage)).toBe(false);
    saveOverviewPanelsExpanded("demo", true, storage);

    expect(readOverviewPanelsExpanded("demo", storage)).toBe(true);
    expect(readOverviewPanelsExpanded("another", storage)).toBe(false);
  });

  it("存储不可用或读写失败时保持可用的默认折叠状态", () => {
    const unavailable = {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { throw new Error("storage unavailable"); },
    };

    expect(readOverviewPanelsExpanded("demo", unavailable)).toBe(false);
    expect(() => saveOverviewPanelsExpanded("demo", true, unavailable)).not.toThrow();
    expect(readOverviewPanelsExpanded("demo", null)).toBe(false);
    expect(() => saveOverviewPanelsExpanded("demo", true, null)).not.toThrow();
  });
});
