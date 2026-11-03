import { describe, expect, it } from "vitest";
import { blogIndexNotice } from "./blog-recognition";

const recognizedAt = "2026-11-01T03:00:00.000Z";
const configured = { blog_sitemaps: ["https://demo.example.test/blog-sitemap.xml"] };

describe("博客列表旧索引提示", () => {
  it("配置更新时间晚于最近成功识别且列表非空时说明当前索引过期", () => {
    expect(blogIndexNotice(configured, Date.parse("2026-11-02T00:00:00.000Z"), recognizedAt, 12, "2026-11-01"))
      .toBe("博客识别配置已更新，当前列表来自旧索引（最近识别于 2026-11-01），重新抓取后生效");
  });

  it("配置已清空但列表非空时说明列表仍来自旧索引", () => {
    expect(blogIndexNotice(undefined, Date.parse("2026-11-02T00:00:00.000Z"), recognizedAt, 12, "2026-11-01"))
      .toBe("当前未配置博客识别，下方列表来自旧索引");
  });

  it("列表为空或识别已晚于配置更新时间时不显示旧索引提示", () => {
    expect(blogIndexNotice(configured, Date.parse("2026-11-02T00:00:00.000Z"), recognizedAt, 0, "2026-11-01")).toBeNull();
    expect(blogIndexNotice(configured, Date.parse("2026-10-31T00:00:00.000Z"), recognizedAt, 12, "2026-11-01")).toBeNull();
  });
});
