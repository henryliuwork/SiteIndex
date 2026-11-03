import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const indexDirectory = resolve(repositoryRoot, "fixtures/expected/project/index");

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(indexDirectory, relativePath), "utf8")) as T;
}

async function readJsonl<T>(relativePath: string): Promise<T[]> {
  const source = await readFile(resolve(indexDirectory, relativePath), "utf8");
  return source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

const reportDirectory = resolve(indexDirectory, "reports/daily");
const reportFiles = (await readdir(reportDirectory)).filter((name) => name.endsWith(".md")).sort();
const generatedSkuCountPerProject = 10_000;
const demoDomain = "demo-store.example.test";
const demoBaseUrl = `https://${demoDomain}`;
const exampleImage = (index: number) => `https://images.example.test/demo/item-${String(index + 1).padStart(3, "0")}.webp`;
const valueString = (value: unknown): string => typeof value === "string" ? value : "";
const valueStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const [sourceSkus, sourceProducts, sourceStock, sourceCategories, sourceEvents, sourcePages, sourceBlogs, sourceKeywords, sourceRuns] = await Promise.all([
  readJsonl<Record<string, unknown>>("catalog/skus.jsonl"),
  readJsonl<Record<string, unknown>>("views/products.jsonl"),
  readJsonl<Record<string, unknown>>("inventory/latest.jsonl"),
  readJson<Record<string, unknown>[]>("catalog/categories.json"),
  readJsonl<Record<string, unknown>>("inventory/events/2026-10.jsonl"),
  readJsonl<Record<string, unknown>>("catalog/pages.jsonl"),
  readJsonl<Record<string, unknown>>("content/blog_index.jsonl"),
  readJsonl<Record<string, unknown>>("content/keywords.jsonl"),
  readJsonl<Record<string, unknown>>("logs/runs.jsonl"),
]);
const skuValues = [...new Set([...sourceSkus.map((row) => valueString(row.sku)), ...sourceProducts.flatMap((row) => valueStrings(row.skus))].filter(Boolean))];
const skuMap = new Map(skuValues.map((sku, index) => [sku, `DEMO${String(index + 1).padStart(3, "0")}A`]));
const skuFor = (value: unknown) => skuMap.get(valueString(value)) ?? "DEMO9999A";
const handles = [...new Set([...sourceProducts, ...sourceSkus].map((row) => valueString(row.handle)).filter(Boolean))];
const handleMap = new Map(handles.map((handle, index) => [handle, `demo-item-${String(index + 1).padStart(3, "0")}`]));
const handleFor = (value: unknown) => handleMap.get(valueString(value)) ?? "demo-item-001";
const productIds = [...new Set([...sourceProducts, ...sourceSkus].map((row) => valueString(row.product_id)).filter(Boolean))];
const productIdMap = new Map(productIds.map((id, index) => [id, `DEMO-PRODUCT-${String(index + 1).padStart(3, "0")}`]));
const productIdFor = (value: unknown) => productIdMap.get(valueString(value)) ?? "DEMO-PRODUCT-001";
const demoPrice = (index: number) => Number((12.34 + (index % 9) * 1.11).toFixed(2));
const demoCategory = (index: number) => ({ slug: `demo-category-${(index % 4) + 1}`, name: `示例分类 ${(index % 4) + 1}` });
const safeCategories = sourceCategories.map((_row, index) => ({
  slug: demoCategory(index).slug, name: demoCategory(index).name,
  url: `${demoBaseUrl}/collections/${demoCategory(index).slug}`, parent: null, source: "feed",
  product_count: 3 + index, sku_count: 4 + index, in_stock_count: 2 + index, last_seen: "2026-10-22",
}));
const site = {
  schema_version: "1.0", domain: demoDomain, base_url: demoBaseUrl, platform: "shopify",
  currency: "USD", locale: "en-US", timezone: "UTC", markets: ["示例市场"],
  brand: { name: "Demo Store", tagline: "仅用于界面演示的虚构品牌。", voice: "简洁、友好的演示语气", audience: "演示用户", usp: ["虚构示例"] },
  crawl: { adapter: "gmc_feed", feed_url: "https://feed.example.test/catalog.xml", sku_field: "id", category_depth: 2 },
  sitemaps: [`${demoBaseUrl}/sitemap.xml`],
};
const safeSkus = sourceSkus.map((row, index) => {
  const handle = handleFor(row.handle);
  return {
    ...row, sku: skuFor(row.sku), product_id: productIdFor(row.product_id), handle,
    title: `演示产品 ${index + 1}`, variant_title: row.variant_title ? `样式 ${index + 1}` : null,
    url: `${demoBaseUrl}/products/${handle}`, category: demoCategory(index).slug, categories: [demoCategory(index).slug],
    category_source: "feed", first_seen: "2026-10-01", last_seen: "2026-10-22", updated_at: "2026-10-22",
    price: demoPrice(index), compare_at_price: null, currency: "USD", image_url: null, additional_images: [],
    gtin: null, mpn: null, brand: "Demo Store",
  };
});
const safeProducts = sourceProducts.map((row, index) => {
  const handle = handleFor(row.handle);
  return {
    ...row, handle, product_id: productIdFor(row.product_id), title: `演示产品 ${index + 1}`,
    url: `${demoBaseUrl}/products/${handle}`,
    price_min: demoPrice(index), price_max: demoPrice(index), compare_at_max: null, currency: "USD",
    on_sale: false, image_url: exampleImage(index), image_source: "none", feed_image_url: null, manual_image_url: null,
    category: demoCategory(index).slug, categories: [demoCategory(index).slug],
    variant_count: valueStrings(row.skus).length, in_stock_variants: Math.max(0, valueStrings(row.skus).length - 1),
    stock_status: index % 3 === 0 ? "out_of_stock" : "in_stock", stock_since: index % 3 === 0 ? "2026-10-18" : null,
    skus: valueStrings(row.skus).map(skuFor), tags: ["演示标签"], priority: null, exclude_edm: 0,
    last_featured: null, days_since_featured: null, short_description: "仅用于界面演示的虚构商品。", email_blurb: "虚构演示商品。",
    first_seen: "2026-10-01", status: "active",
  };
});
const stockStatuses = ["in_stock", "in_stock", "out_of_stock", "unknown"] as const;
const safeStock = sourceStock.map((row, index) => ({
  ...row, sku: skuFor(row.sku), stock_status: stockStatuses[index % stockStatuses.length],
  qty: (index * 3) % 17 + 1, since: "2026-10-18", checked_at: "2026-10-22T02:00:00Z",
}));
const safeEvents = sourceEvents.map((row, index) => ({
  ...row, date: `2026-10-${String(22 - index).padStart(2, "0")}`, sku: skuFor(row.sku),
  from: row.type === "price_change" ? demoPrice(index) - 1.11 : "out_of_stock",
  to: row.type === "price_change" ? demoPrice(index) : "in_stock", category: demoCategory(index).slug, title: `示例库存变化 ${index + 1}`,
}));
const safePages = sourcePages.map((row, index) => ({
  ...row, url: `${demoBaseUrl}/demo/page-${index + 1}`, title: `示例页面 ${index + 1}`,
  meta_description: "仅用于界面演示的虚构页面。", h1: `示例页面标题 ${index + 1}`,
  canonical: `${demoBaseUrl}/demo/page-${index + 1}`, last_crawled: "2026-10-22", word_count: 120 + index * 20,
  status_code: index === 1 ? 404 : 200, indexable: index !== 1,
}));
const safeBlogs = sourceBlogs.map((row, index) => ({
  ...row, url: `${demoBaseUrl}/blog/demo-article-${index + 1}`, slug: `demo-article-${index + 1}`,
  title: `示例博客文章 ${index + 1}`, category: "示例博客", author: "演示编辑", tags: ["示例内容"],
  published_at: `2026-10-${String(20 - index).padStart(2, "0")}`, updated_at: null,
  meta_description: "仅用于界面演示的虚构文章。", featured_image: null, word_count: 500 + index * 100,
  reading_minutes: 4 + index, outline: ["示例主题", "示例内容"], has_faq: index % 2 === 0,
  primary_keyword: `示例关键词 ${index + 1}`, last_crawled: "2026-10-22", links_in: index + 1, linked_out_of_stock: [],
  links_internal: [`${demoBaseUrl}/`, `${demoBaseUrl}/collections/demo-category-1`],
  links_products: [handleFor(sourceProducts[index % Math.max(sourceProducts.length, 1)]?.handle)],
}));
const safeKeywords = sourceKeywords.map((row, index) => ({
  ...row, keyword: `示例关键词 ${index + 1}`, target_url: `${demoBaseUrl}/demo/page-${index + 1}`,
  cluster: "示例主题", source: "演示", note: "虚构的界面演示数据。", search_volume: 100 + index * 40, difficulty: 20 + index * 5,
  current_rank: 4 + index, rank_checked_at: "2026-10-22", updated_at: "2026-10-22",
}));
const safeRuns = sourceRuns.map((row, index) => ({
  ...row, run_id: `demo-run-${String(index + 1).padStart(3, "0")}`, job: "daily", device_name: "演示设备",
  started_at: `2026-10-${String(22 - index).padStart(2, "0")}T02:00:00Z`, finished_at: `2026-10-${String(22 - index).padStart(2, "0")}T02:01:00Z`,
  status: index % 3 === 1 ? "partial" : "ok",
  counts: { restock: index % 3, out_of_stock: (index + 1) % 4, price: index % 2, new: 1 },
  errors: index % 3 === 1 ? ["示例任务提示：演示数据无需处理。"] : [],
}));
const dailyReports = reportFiles.map((_name, index) => ({
  date: `2026-10-${String(22 - index).padStart(2, "0")}`,
  markdown: `# 示例库存日报\n\n这是第 ${index + 1} 份虚构日报，仅用于界面演示。\n`,
}));

const mockData = {
  generatedSkuCount: generatedSkuCountPerProject * 2,
  projects: [
    { id: "demo", name: "Demo Store", domain: demoDomain, source: "generated" },
    { id: "demo2", name: "Demo Catalog", domain: "demo-catalog.example.test", source: "generated" },
  ],
  site,
  skus: safeSkus,
  products: safeProducts,
  stock: safeStock,
  categories: safeCategories,
  events: safeEvents,
  pages: safePages,
  blogs: safeBlogs,
  keywords: safeKeywords,
  runs: safeRuns,
  dailyReports,
};

if (mockData.skus.length === 0 || mockData.products.length === 0) {
  throw new Error("UI mock source data is empty; cannot build demo mock data.");
}

await writeFile(resolve(scriptDirectory, "../src/mock/data.json"), `${JSON.stringify(mockData, null, 2)}\n`, "utf8");
console.log(`Built anonymized UI mock data (${mockData.skus.length} synthetic seed SKUs, ${generatedSkuCountPerProject.toLocaleString("en-US")} generated SKU slots per project).`);
