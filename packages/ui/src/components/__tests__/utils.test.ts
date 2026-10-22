import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLengthGrade, getPaginationModel, nextFilterValue, readColumnPrefs, writeColumnPrefs } from "../utils";

describe("筛选状态", () => {
  it("同一筛选再次点击时清除，切换到另一筛选时更新", () => {
    expect(nextFilterValue(undefined, "in_stock")).toBe("in_stock");
    expect(nextFilterValue("in_stock", "in_stock")).toBeUndefined();
    expect(nextFilterValue("in_stock", "out_of_stock")).toBe("out_of_stock");
  });
});

describe("服务端分页", () => {
  it("计算当前范围、页数并夹紧非法页码", () => {
    expect(getPaginationModel(9, 50, 124)).toEqual({ page: 3, pageSize: 50, pageCount: 3, from: 101, to: 124, total: 124 });
    expect(getPaginationModel(0, 20, 0)).toEqual({ page: 1, pageSize: 20, pageCount: 1, from: 0, to: 0, total: 0 });
  });
});

describe("SEO 长度标色", () => {
  it("使用 shared 的标题和描述区间计算绿橙红状态", () => {
    expect(getLengthGrade(45, "title")).toBe("good");
    expect(getLengthGrade(25, "title")).toBe("fair");
    expect(getLengthGrade(15, "title")).toBe("poor");
    expect(getLengthGrade(140, "description")).toBe("good");
    expect(getLengthGrade(90, "description")).toBe("fair");
    expect(getLengthGrade(50, "description")).toBe("poor");
  });
});

describe("列设置持久化", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("保存到 si.cols.{tableId} 并过滤已移除的列", () => {
    writeColumnPrefs("inventory", ["sku", "stock", "sku"]);
    expect(values.get("si.cols.inventory")).toBe('["sku","stock"]');
    expect(readColumnPrefs("inventory", ["sku", "stock", "category"])).toEqual(["sku", "stock"]);
  });

  it("损坏的存储值回退到默认列", () => {
    values.set("si.cols.inventory", "not-json");
    expect(readColumnPrefs("inventory", ["sku", "stock"], ["sku"])).toEqual(["sku"]);
  });
});
