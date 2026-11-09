import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime, getLengthGrade, getPaginationModel, nextFilterValue, normalizeTablePageSize, readColumnPrefs, writeColumnPrefs } from "../utils";

describe("日期和时间格式", () => {
  const now = new Date(2026, 10, 9, 12, 0);

  it("同年输出月日和本地时间，不添加今天前缀", () => {
    expect(formatDateTime(new Date(2026, 10, 8, 17, 0), now)).toBe("11-08 17:00");
  });

  it("跨年时包含年份并处理空值和非法日期", () => {
    expect(formatDateTime(new Date(2025, 11, 31, 23, 5), now)).toBe("2025-12-31 23:05");
    expect(formatDateTime(null, now)).toBe("—");
    expect(formatDateTime("bad-date", now)).toBe("—");
  });
});

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
    expect(getPaginationModel(0, 50, 0)).toEqual({ page: 1, pageSize: 50, pageCount: 1, from: 0, to: 0, total: 0 });
  });

  it("supports 50/100/200/all and keeps all rows on a single virtualized page", () => {
    expect(normalizeTablePageSize(200)).toBe(200);
    expect(getPaginationModel(3, 200, 450)).toEqual({ page: 3, pageSize: 200, pageCount: 3, from: 401, to: 450, total: 450 });
    expect(getPaginationModel(4, 0, 450)).toEqual({ page: 1, pageSize: 0, pageCount: 1, from: 1, to: 450, total: 450 });
    expect(normalizeTablePageSize(20)).toBe(50);
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
