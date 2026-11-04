import { describe, expect, it } from "vitest";
import { createContentMock } from "../content";
import { createEdmMock } from "../edm";
import { createInventoryMock } from "../inventory";
import { createProductsMock } from "../products";
import { createSeoMock } from "../seo";
import { generatedBlogs, productsByProject, selectRows, seoPages, tagsByHandle } from "../context";

function compareKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareValue(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1;
  return compareKey(String(left), String(right));
}

function expectCoreSort<T extends object>(rows: T[], field: keyof T, key: (row: T) => string) {
  const expected = [...rows].sort((left, right) => compareValue(left[field], right[field]) || compareKey(key(left), key(right))).map(key);
  expect(rows.map(key)).toEqual(expected);
}

describe("UI mock 与 Core 查询语义对齐", () => {
  it("产品搜索包含 product_id、SKU 与分类数组，分类和标签过滤与 Core 一致", async () => {
    const api = createProductsMock();
    const product = productsByProject.demo[0]!;
    const originalProduct = product;
    const categoryAlias = "demo-category-search-alias";
    productsByProject.demo[0] = { ...product, categories: [...product.categories, categoryAlias] };

    const handleKey = `demo:${product.handle}`;
    const previousTags = tagsByHandle.get(handleKey);
    tagsByHandle.set(handleKey, ["SpringTag"]);
    try {
      const byProductId = await api.list("demo", { page: 1, pageSize: 0, search: product.product_id });
      const bySku = await api.list("demo", { page: 1, pageSize: 0, search: product.skus[0] });
      const byCategory = await api.list("demo", { page: 1, pageSize: 0, search: categoryAlias });
      const filteredCategory = await api.list("demo", { page: 1, pageSize: 0, filters: { category: categoryAlias } });
      const filteredTag = await api.list("demo", { page: 1, pageSize: 0, filters: { tag: "springtag" } });

      expect(byProductId.rows.map((row) => row.handle)).toContain(product.handle);
      expect(bySku.rows.map((row) => row.handle)).toContain(product.handle);
      expect(byCategory.rows.map((row) => row.handle)).toContain(product.handle);
      expect(filteredCategory.rows.map((row) => row.handle)).toContain(product.handle);
      expect(filteredTag.rows.map((row) => row.handle)).toContain(product.handle);
    } finally {
      productsByProject.demo[0] = originalProduct;
      if (previousTags) tagsByHandle.set(handleKey, previousTags);
      else tagsByHandle.delete(handleKey);
    }
  });

  it("产品详情没有记录时返回 null，未找到产品时不回退到其他商品", async () => {
    const api = createProductsMock();
    const productWithoutSeo = productsByProject.demo.find((row) => !seoPages.some((page) => page.url === row.url))!;
    const full = await api.get("demo", productWithoutSeo.handle);
    expect(full.details).toBeNull();
    expect(full.seo).toBeNull();
    await expect(api.get("demo", "missing-demo-product")).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("SEO 搜索包含严重级别、状态和 page_type，并按 Core 默认键排序", async () => {
    const api = createSeoMock();
    const highIssues = await api.listIssues("demo", { page: 1, pageSize: 0, search: "high" });
    const openIssues = await api.listIssues("demo", { page: 1, pageSize: 0, search: "open" });
    const homePages = await api.listPages("demo", { page: 1, pageSize: 0, search: "home" });
    const pages = await api.listPages("demo", { page: 1, pageSize: 0 });
    const links = await api.listLinks("demo", { page: 1, pageSize: 0 });

    expect(highIssues.rows.length).toBeGreaterThan(0);
    expect(highIssues.rows.every((row) => row.severity === "high")).toBe(true);
    expect(openIssues.rows.length).toBeGreaterThan(0);
    expect(openIssues.rows.every((row) => row.status === "open")).toBe(true);
    expect(homePages.rows.map((row) => row.page_type)).toEqual(["home"]);
    expectCoreSort(highIssues.rows.length ? (await api.listIssues("demo", { page: 1, pageSize: 0 })).rows : [], "severity", (row) => `${row.url}\u0000${row.rule}`);
    expectCoreSort(pages.rows, "url", (row) => row.url);
    expectCoreSort(links.rows, "from", (row) => `${row.from}\u0000${row.to}\u0000${row.anchor}`);
  });

  it("内容搜索包含 Core 字段，并按文章 schema 与 Core 一致筛选", async () => {
    const api = createContentMock();
    const byUrl = await api.listBlog("demo", { page: 1, pageSize: 0, search: "demo-store.example.test" });
    const byAuthor = await api.listBlog("demo", { page: 1, pageSize: 0, search: "Demo Editorial" });
    const byTag = await api.listBlog("demo", { page: 1, pageSize: 0, search: "product guide" });
    const byIntent = await api.listKeywords("demo", { page: 1, pageSize: 0, search: "informational" });
    const byNote = await api.listKeywords("demo", { page: 1, pageSize: 0, search: "核心词待补目标页" });
    const noSchema = await api.listBlog("demo", { page: 1, pageSize: 0, filters: { issue: "no_schema" } });
    const noLinks = await api.listBlog("demo", { page: 1, pageSize: 0, filters: { issue: "no_links" } });
    const summary = await api.summary("demo");
    const expectedNoSchema = generatedBlogs.filter((blog) => {
      const page = seoPages.find((candidate) => candidate.url === blog.url);
      return !page?.schema_types?.some((type) => /article|blogposting/i.test(type));
    });
    const expectedNoLinks = generatedBlogs.filter((blog) => blog.links_internal.length === 0 && blog.links_products.length === 0);

    expect(byUrl.total).toBe(generatedBlogs.length);
    expect(byAuthor.total).toBe(generatedBlogs.length);
    expect(byTag.total).toBe(generatedBlogs.length);
    expect(byIntent.rows.length).toBeGreaterThan(0);
    expect(byIntent.rows.every((row) => row.intent === "informational")).toBe(true);
    expect(byNote.rows.length).toBeGreaterThan(0);
    expect(byNote.rows.every((row) => row.note === "核心词待补目标页")).toBe(true);
    expect(noSchema.rows.map((row) => row.url).sort(compareKey)).toEqual(expectedNoSchema.map((row) => row.url).sort(compareKey));
    expect(summary.kpis.find((metric) => metric.key === "no_schema")?.value).toBe(String(expectedNoSchema.length));
    expect(noLinks.rows.map((row) => row.url).sort(compareKey)).toEqual(expectedNoLinks.map((row) => row.url).sort(compareKey));
    expect(summary.kpis.find((metric) => metric.key === "no_links")?.value).toBe(String(expectedNoLinks.length));
  });

  it("分页列表使用 Core 的默认排序与稳定平局键", async () => {
    const all = { page: 1, pageSize: 0 };
    const productRows = await createProductsMock().list("demo", all);
    const issues = await createSeoMock().listIssues("demo", all);
    const pages = await createSeoMock().listPages("demo", all);
    const links = await createSeoMock().listLinks("demo", all);
    const blogs = await createContentMock().listBlog("demo", all);
    const keywords = await createContentMock().listKeywords("demo", all);
    const skus = await createInventoryMock().listSkus("demo", all);
    const images = await createEdmMock().listImages("demo", all);

    expectCoreSort(productRows.rows, "handle", (row) => row.handle);
    expectCoreSort(issues.rows, "severity", (row) => `${row.url}\u0000${row.rule}`);
    expectCoreSort(pages.rows, "url", (row) => row.url);
    expectCoreSort(links.rows, "from", (row) => `${row.from}\u0000${row.to}\u0000${row.anchor}`);
    expectCoreSort(blogs.rows, "published_at", (row) => row.url);
    expectCoreSort(keywords.rows, "keyword", (row) => row.keyword);
    expectCoreSort(skus.rows, "sku", (row) => row.sku);
    expectCoreSort(images.rows, "sku", (row) => row.sku);

    const tiedRows = [{ id: "z-row", rank: 1 }, { id: "a-row", rank: 1 }];
    const tied = selectRows(tiedRows, { ...all, sort: { field: "rank", dir: "desc" } }, () => "", () => true, "rank", (row) => row.id);
    expect(tied.rows.map((row) => row.id)).toEqual(["a-row", "z-row"]);
  });
});
