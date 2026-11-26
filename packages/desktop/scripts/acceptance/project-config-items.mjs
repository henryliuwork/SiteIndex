import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

// v0.8.2 setting matrix rows 1–20. Each descriptor is run in its own profile by the shared driver.
export const PROJECT_CONFIG_ITEMS = [
  { id: 1, path: "crawl.user_agent", expected: "SiteIndexSynthetic/2.0", kind: "json" },
  { id: 2, path: "domain", expected: "edited.example.test", kind: "text", name: "域名" },
  { id: 3, path: "base_url", expected: "https://edited.example.test", kind: "text", name: "网站地址" },
  { id: 4, path: "platform", expected: "other", kind: "select", region: "基本信息" },
  { id: 5, path: "currency", expected: "EUR", kind: "text", name: "币种" },
  { id: 6, path: "locale", expected: "en-GB", kind: "text", name: "语言" },
  { id: 7, path: "timezone", expected: "Europe/London", kind: "text", name: "时区" },
  { id: 8, path: "markets", expected: ["US", "CA"], kind: "comma", name: "目标市场（逗号分隔）" },
  { id: 9, path: "brand.name", expected: "Synthetic Edited Brand", kind: "text", name: "品牌名" },
  { id: 10, path: "brand.tagline", expected: "Simple synthetic goods", kind: "text", name: "一句话定位" },
  { id: 11, path: "brand.voice", expected: "Clear and calm", kind: "text", name: "文案调性" },
  { id: 12, path: "brand.audience", expected: "Example shoppers", kind: "text", name: "目标人群" },
  { id: 13, path: "brand.usp", expected: ["Clear records", "Quick setup"], kind: "lines", name: "核心卖点（每行一项）" },
  { id: 14, path: "crawl.feed_url", expected: ["https://feed.example.test/products.xml"], kind: "first", name: "每行一个地址" },
  { id: 15, path: "crawl.sku_field", expected: "sku", kind: "text", name: "SKU 字段" },
  { id: 16, path: "crawl.category_depth", expected: 3, kind: "number", name: "主分类层级" },
  { id: 17, path: "crawl.missing_as", expected: "removed", kind: "select", region: "数据源 · GMC feed" },
  { id: 18, path: "crawl.max_removed_ratio", expected: 0.3, kind: "number", name: "移除保护阈值（0–1）" },
  { id: 19, path: "crawl.feed_generated_at", expected: "2026-11-24T01:00:00Z", kind: "text", name: "Feed 生成时间" },
  { id: 20, path: "sitemaps", expected: ["https://edited.example.test/sitemap.xml"], kind: "first", name: "站点地图（每行一个）" },
];

export function projectConfigItem(id) {
  const item = PROJECT_CONFIG_ITEMS.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown project config matrix row ${id}`);
  return item;
}

export function projectConfigValue(config, path) {
  return path.split(".").reduce((value, part) => value?.[part], config);
}

function setProjectConfigValue(config, path, value) {
  const parts = path.split(".");
  const target = parts.slice(0, -1).reduce((section, part) => section[part], config);
  target[parts.at(-1)] = value;
}

/** Edits only one field and saves it through the installed application's UI. */
export async function editProjectConfigItem(page, item, projectId) {
  if (item.kind === "json") {
    await page.getByRole("button", { name: "以 JSON 编辑" }).click();
    const editor = page.getByRole("textbox", { name: "项目 JSON" });
    const config = JSON.parse(await editor.inputValue());
    setProjectConfigValue(config, item.path, item.expected);
    await editor.fill(JSON.stringify(config, null, 2));
    await page.getByRole("button", { name: "应用 JSON" }).click();
  } else {
    const role = item.kind === "select" ? "combobox" : item.kind === "number" ? "spinbutton" : "textbox";
    // v0.8.0 nested <label> may include option text in a combobox name; scope by the named region.
    const control = item.kind === "select"
      ? page.getByRole("region", { name: item.region }).getByRole("combobox")
      : page.getByRole(role, { name: item.name, exact: true });
    if (item.kind === "select") await control.selectOption(item.expected);
    else await control.fill(item.kind === "comma" ? item.expected.join(", ")
      : item.kind === "lines" ? item.expected.join("\n")
        : item.kind === "first" ? item.expected[0] : String(item.expected));
  }
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await waitForObserved(async () => {
    const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
    return isDeepStrictEqual(projectConfigValue(project.config, item.path), item.expected);
  }, { timeoutMs: 20_000, label: `project config row ${item.id} saved via IPC` });
}

/** Call after a normal exit and again after the candidate overwrite install. */
export async function verifyProjectConfigFile(item, siteFile) {
  const config = JSON.parse(await readFile(siteFile, "utf8"));
  assertPersisted(projectConfigValue(config, item.path), item.expected);
  return { id: item.id, phase: "file-readback", status: "passed" };
}

/** Call from fresh baseline and candidate sessions; never use an in-memory draft. */
export async function verifyProjectConfigIpc(item, page, projectId) {
  const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
  assertPersisted(projectConfigValue(project.config, item.path), item.expected);
  return { id: item.id, phase: "ipc-readback", status: "passed" };
}
