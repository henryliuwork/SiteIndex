import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

// v0.8.2 setting matrix rows 21–45; the future shared driver supplies a separate profile per row.
export const ADVANCED_CONFIG_ITEMS = [
  { id: 21, path: "crawl.overrides", expected: { "SYN-001": { title: "Synthetic override" } }, kind: "json", name: "数据修正（overrides，JSON 对象）" },
  { id: 22, path: "crawl.rate_limit_ms", expected: 2400, kind: "number", name: "请求间隔（毫秒）" },
  { id: 23, path: "crawl.max_pages", expected: 1200, kind: "number", name: "每周最多页面" },
  { id: 24, path: "crawl.crawl_product_pages", expected: false, kind: "checkbox", name: "每周抓取产品页 SEO" },
  { id: 25, path: "crawl.auto_collect_products", expected: true, kind: "checkbox", name: "无 Feed 时自动采集商品" },
  { id: 26, path: "crawl.exclude_url_patterns", expected: ["/synthetic-private/*"], kind: "lines", name: "排除 URL 规则（每行一条）" },
  { id: 27, path: "content.blog_sitemaps", expected: ["https://blog.example.test/post-sitemap.xml"], kind: "lines", name: "博客 Sitemap（每行一个地址）" },
  { id: 28, path: "content.blog_url_patterns", expected: ["/journal/*"], kind: "lines", name: "博客 URL 前缀或规则（每行一条）" },
  { id: 29, path: "sku_grouping.enabled", expected: true, kind: "checkbox", name: "启用父子 SKU 分组" },
  { id: 30, path: "sku_grouping.rule.type", expected: "suffix", kind: "select", region: "父子 SKU", selectIndex: 0 },
  { id: 31, path: "sku_grouping.rule.value", expected: "^(.+?)-[A-Z]{2}$", kind: "text", name: "规则值" },
  { id: 32, path: "categories.watched", expected: [{ name: "Synthetic Category", slug: "synthetic-category", url: "https://config.example.test/category/synthetic-category", manual: true }], kind: "category" },
  { id: 33, path: "seo.core_keywords", expected: ["synthetic lighting", "example goods"], kind: "lines", name: "核心关键词（每行一项）" },
  { id: 34, path: "seo.competitors", expected: ["competitor.example.test"], kind: "lines", name: "竞品域名（每行一个）" },
  { id: 35, path: "seo.title_range", expected: [32, 62], kind: "range", names: ["Title 最短长度", "Title 最长长度"] },
  { id: 36, path: "seo.description_range", expected: [72, 158], kind: "range", names: ["Description 最短长度", "Description 最长长度"] },
  { id: 37, path: "edm.platform", expected: "other", kind: "select", region: "EDM", selectIndex: 0 },
  { id: 38, path: "edm.max_products", expected: 8, kind: "number", name: "每封产品数" },
  { id: 39, path: "edm.cooldown_days", expected: 14, kind: "number", name: "推荐冷却期（天）" },
  { id: 40, path: "edm.utm.source", expected: "synthetic_newsletter", kind: "text", name: "UTM source" },
  { id: 41, path: "edm.utm.medium", expected: "example_email", kind: "text", name: "UTM medium" },
  { id: 42, path: "edm.image_priority", expected: ["manual", "feed"], kind: "select", region: "EDM", selectIndex: 1 },
  { id: 43, path: "integrations.mailchimp.audience", expected: "synthetic-audience", kind: "text", name: "默认受众" },
  { id: 44, path: "integrations.linkflow.mcp_server", expected: "synthetic-mcp", kind: "text", name: "LinkFlow MCP 服务" },
  { id: 45, path: "integrations.linkflow.create_tool", expected: "synthetic-create", kind: "text", name: "录入工具" },
];

export function advancedConfigItem(id) {
  const item = ADVANCED_CONFIG_ITEMS.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown advanced config matrix row ${id}`);
  return item;
}

const valueAt = (config, path) => path.split(".").reduce((value, part) => value?.[part], config);

/** Uses accessible roles only; lifecycle and upgrade are supplied by the shared driver. */
export async function editAdvancedConfigItem(page, item, projectId) {
  if (item.kind === "category") {
    const region = page.getByRole("region", { name: "关注的分类" });
    for (const [name, value] of [["分类名称", item.expected[0].name], ["Slug", item.expected[0].slug],
      ["分类 URL", item.expected[0].url]]) {
      await region.getByRole("textbox", { name, exact: true }).fill(value);
    }
    await region.getByRole("button", { name: "添加关注分类" }).click();
  } else if (item.kind === "range") {
    for (let index = 0; index < 2; index++) {
      await page.getByRole("spinbutton", { name: item.names[index], exact: true }).fill(String(item.expected[index]));
    }
  } else if (item.kind === "checkbox") {
    const control = page.getByRole("checkbox", { name: item.name, exact: true });
    if (await control.isChecked() !== item.expected) await control.click();
  } else if (item.kind === "select") {
    const control = page.getByRole("region", { name: item.region }).getByRole("combobox").nth(item.selectIndex);
    await control.selectOption(Array.isArray(item.expected) ? item.expected.join(",") : item.expected);
  } else {
    const role = item.kind === "number" ? "spinbutton" : "textbox";
    const control = page.getByRole(role, { name: item.name, exact: true });
    await control.fill(item.kind === "json" ? JSON.stringify(item.expected)
      : item.kind === "lines" ? item.expected.join("\n") : String(item.expected));
  }
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await waitForObserved(async () => {
    const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
    return isDeepStrictEqual(valueAt(project.config, item.path), item.expected);
  }, { timeoutMs: 20_000, label: `advanced config row ${item.id} saved via IPC` });
}

export async function verifyAdvancedConfigFile(item, siteFile) {
  const config = JSON.parse(await readFile(siteFile, "utf8"));
  assertPersisted(valueAt(config, item.path), item.expected);
  return { id: item.id, phase: "file-readback", status: "passed" };
}

export async function verifyAdvancedConfigIpc(item, page, projectId) {
  const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
  assertPersisted(valueAt(project.config, item.path), item.expected);
  return { id: item.id, phase: "ipc-readback", status: "passed" };
}
