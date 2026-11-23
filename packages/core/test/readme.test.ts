import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS, pathsFor, type DesignTokens, type ProjectLayout, type SiteConfig } from "@siteindex/shared";
import {
  buildReadmeAutoContent,
  createCoreService,
  parseReadmeAutoBlocks,
  replaceReadmeAutoBlocks,
  type ReadmeAutoContentInput,
  type ReadmeAutoContent,
} from "../src";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];

async function makeProject(layout: ProjectLayout = "legacy"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-readme-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  if (layout === "workspace") {
    await rename(path.join(projectPath, PATHS.index), path.join(projectPath, pathsFor(layout).index));
  }
  return projectPath;
}

async function makeSyntheticReadmeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-readme-synthetic-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "synthetic-project");
  await cp(path.resolve(process.cwd(), "fixtures/e-v050-w0/projects/legacy"), projectPath, { recursive: true });
  const template = await readFile(path.resolve(process.cwd(), "templates/project/README.md"), "utf8");
  await writeFile(path.join(projectPath, PATHS.readme),
    template.replace('<!-- siteindex:auto:end id="index-summary" -->',
      'Synthetic generated content\n<!-- siteindex:auto:end id="index-summary" -->'), "utf8");
  return projectPath;
}

function service(projectPath: string) {
  return createCoreService({ resolveProject: () => projectPath, deviceId: "test-device", cacheDir: path.join(path.dirname(projectPath), "cache") });
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const emptyContents: ReadmeAutoContent = {
  "index-summary": "## 网站数据速览",
  "task-routing": "## 任务路由",
  "data-guide": "## 数据指南",
  "design-summary": "## 设计规范速览",
  changelog: "## 变更记录",
};

describe("README automatic blocks", () => {
  it("keeps generated blocks outside the user rules section while saving", async () => {
    const projectPath = await makeSyntheticReadmeProject();
    const api = service(projectPath);
    const readmePath = path.join(projectPath, PATHS.readme);
    const before = await readFile(readmePath, "utf8");
    const autoBlocks = parseReadmeAutoBlocks(before);
    expect(autoBlocks).toHaveLength(5);
    expect((await api.readme.get("synthetic")).user_blocks.rules).not.toContain("siteindex:auto");

    await api.readme.saveUserBlocks("synthetic", {
      overview: "Synthetic overview", focus: "Synthetic focus", rules: "Synthetic rules",
    });
    const saved = await readFile(readmePath, "utf8");
    expect(parseReadmeAutoBlocks(saved)).toEqual(autoBlocks);
    expect((await api.readme.get("synthetic")).user_blocks).toEqual({
      overview: "Synthetic overview", focus: "Synthetic focus", rules: "Synthetic rules",
    });
    await api.readme.saveUserBlocks("synthetic", {
      overview: "Synthetic overview", focus: "Synthetic focus", rules: "Synthetic rules",
    });
    expect(await readFile(readmePath, "utf8")).toBe(saved);
  });

  it("appends a missing user heading and preserves all user blocks through refresh", async () => {
    const projectPath = await makeSyntheticReadmeProject();
    const api = service(projectPath);
    const readmePath = path.join(projectPath, PATHS.readme);
    const before = await readFile(readmePath, "utf8");
    await writeFile(readmePath, before.replace(/## 当前重点\r?\n[^\r\n]*\r?\n/, ""), "utf8");
    const blocks = { overview: "Synthetic overview", focus: "Synthetic focus", rules: "Synthetic rules" };

    await api.readme.saveUserBlocks("synthetic", blocks);
    const saved = await readFile(readmePath, "utf8");
    expect(saved).toContain("## 当前重点\nSynthetic focus\n");
    expect(parseReadmeAutoBlocks(saved)).toHaveLength(5);
    expect((await api.readme.get("synthetic")).user_blocks).toEqual(blocks);

    await api.readme.refresh("synthetic");
    expect((await api.readme.get("synthetic")).user_blocks).toEqual(blocks);
    expect(parseReadmeAutoBlocks(await readFile(readmePath, "utf8"))).toHaveLength(5);
  }, 15_000);

  it("parses and replaces block bodies while preserving every byte outside their markers", () => {
    const source = [
      "用户区块含有 $& 和 CRLF",
      '<!-- siteindex:auto:start id="changelog" -->',
      "旧内容",
      '<!-- siteindex:auto:end id="changelog" -->',
      "尾部用户内容",
      "",
    ].join("\r\n");
    expect(parseReadmeAutoBlocks(source)).toEqual([{ id: "changelog", content: "旧内容" }]);
    const updated = replaceReadmeAutoBlocks(
      source,
      { ...emptyContents, changelog: "新内容含有 $&" },
      new Set(["index-summary", "task-routing", "data-guide", "design-summary"]),
    );
    expect(updated).toBe(
      '用户区块含有 $& 和 CRLF\r\n<!-- siteindex:auto:start id="changelog" -->\n新内容含有 $&\n<!-- siteindex:auto:end id="changelog" -->\r\n尾部用户内容\r\n',
    );
  });

  it("appends missing blocks in canonical order, respects disabled blocks and rejects malformed markers", () => {
    const output = replaceReadmeAutoBlocks("用户维护的 README。\n", emptyContents);
    expect(parseReadmeAutoBlocks(output).map(({ id }) => id)).toEqual([
      "index-summary", "task-routing", "data-guide", "design-summary", "changelog",
    ]);
    expect(output).toContain("用户维护的 README。\n\n<!-- siteindex:auto:start id=\"index-summary\" -->");
    expect(() => parseReadmeAutoBlocks('<!-- siteindex:auto:start id="folder-map" -->\n内容\n<!-- siteindex:auto:end id="task-routing" -->'))
      .toThrow("README 自动区块标记未成对或存在嵌套。");
    expect(parseReadmeAutoBlocks('<!-- siteindex:auto:start id=folder-map -->')).toEqual([]);
  });

  it("builds the five data-driven blocks from site, inventory, design and run records", () => {
    const tokens: DesignTokens = {
      extracted_at: "2026-10-21T09:00:00Z", source_pages: [], css_variables: {},
      color: { primary: "#123456", text: "#222222", background: "#ffffff", palette: [] },
      typography: { font_families: { heading: "Lora", body: "Inter" }, scale: {} },
      spacing: [], radius: [], shadow: [], components: {}, assets: {},
    };
    const input: ReadmeAutoContentInput = {
      site: { domain: "example.test", platform: "shopify" },
      asOf: "2026-10-21", activeSkus: 8, activeProducts: 4, categories: 2, blogPosts: 3,
      dailySummary: [
        { date: "2026-10-21", category: "_all", total: 100, in_stock: 85, out_of_stock: 15, preorder: 0, unknown: 0 },
        { date: "2026-10-14", category: "_all", total: 100, in_stock: 80, out_of_stock: 20, preorder: 0, unknown: 0 },
      ],
      events: [
        { date: "2026-10-21", sku: "A", type: "stock_change", from: "out_of_stock", to: "in_stock", category: "feeders", title: "Feeder" },
        { date: "2026-10-21", sku: "B", type: "stock_change", from: "in_stock", to: "out_of_stock", category: "feeders", title: "House" },
        { date: "2026-10-21", sku: "C", type: "price_change", from: 20, to: 15, category: "feeders", title: "Bath" },
        { date: "2026-10-21", sku: "D", type: "new_sku", from: null, to: 10, category: "feeders", title: "New" },
      ],
      designTokens: tokens,
      runs: [{ run_id: "run-1", job: "daily", started_at: "2026-10-21T02:04:00-07:00", finished_at: null, status: "ok" }],
    };
    const blocks = buildReadmeAutoContent(input);
    expect(Object.keys(blocks)).toEqual(Object.keys(emptyContents));
    expect(blocks["index-summary"]).toContain("在售 SKU / 产品 | 8 / 4");
    expect(blocks["index-summary"]).toContain("85.0%（较 7 天前 +5.0pt）");
    expect(blocks["index-summary"]).toContain("新到货 1 · 新缺货 1 · 调价 1 · 上新 1");
    expect(blocks["task-routing"]).toContain(`${PATHS.skillsDir}/edm-builder/SKILL.md`);
    expect(blocks["data-guide"]).toContain(`| \`${PATHS.keywords}\` |`);
    expect(blocks["design-summary"]).toContain("#123456");
    expect(blocks.changelog).toContain("每日同步：成功");
  });

  it("refreshes the project README without changing user-maintained sections", async () => {
    const projectPath = await makeProject();
    const readmePath = path.join(projectPath, PATHS.readme);
    const userContent = "# Kingsyard\n\n## 项目概况\n用户维护概况。\n\n## 当前重点\n本周目标。\n\n## 工作规则与偏好\n不要改写此内容。\n";
    await writeFile(readmePath, userContent, "utf8");

    const api = service(projectPath);
    await api.readme.refresh("fixture");
    const generated = await readFile(readmePath, "utf8");
    const blocks = parseReadmeAutoBlocks(generated);
    expect(blocks.map(({ id }) => id)).toEqual(Object.keys(emptyContents));
    expect(generated.startsWith(userContent)).toBe(true);
    expect(generated).not.toContain('id="folder-map"');
    expect(generated).toContain("## 任务路由");
    expect(generated).toContain("## 数据指南（index/）");
    expect(generated).toContain("## 设计规范速览");
    expect((await api.readme.get("fixture")).auto_blocks.map(({ id }) => id)).toEqual(Object.keys(emptyContents));
  }, 15_000);

  it("reads workspace index data and resolves daily reports from _site-index", async () => {
    const projectPath = await makeProject("workspace");
    const paths = pathsFor("workspace");
    const sitePath = path.join(projectPath, paths.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
    site.workspace = { version: "1.0", sections: ["01-brand", "03-seo"], esp_presets: ["mailchimp"] };
    await writeFile(sitePath, JSON.stringify(site), "utf8");
    await writeFile(path.join(projectPath, paths.index, "workspace.json"), JSON.stringify({
      version: "1.0", layout: "workspace",
      sections: [{ id: "brand", dir: "01-brand" }, { id: "seo", dir: "03-seo" }],
      paths: { "catalog.skus": paths.skus, "seo.blog": "03-seo/blog" },
      esp_presets: ["mailchimp"],
    }), "utf8");
    await mkdir(path.dirname(path.join(projectPath, paths.skillsManifest)), { recursive: true });
    await writeFile(path.join(projectPath, paths.skillsManifest), JSON.stringify({
      schema_version: "1.0", skills: [{ name: "demo-skill", version: "1.2.3" }],
    }), "utf8");
    const marker = (id: string) => '<!-- siteindex:auto:start id="' + id + '" -->\n旧自动内容\n<!-- siteindex:auto:end id="' + id + '" -->';
    const readmePath = path.join(projectPath, PATHS.readme);
    const agentsPath = path.join(projectPath, PATHS.agentsMd);
    const userReadme = "# Workspace Demo\n\n用户维护的 README 内容。\n\n";
    const userAgents = "# Agent 手册\n\n用户维护的工作规则。\n\n";
    await writeFile(readmePath, userReadme + ["workspace-map", "index-summary", "changelog"].map(marker).join("\n\n") + "\n", "utf8");
    await writeFile(agentsPath, userAgents + ["agents-core", "task-routing", "data-guide", "design-summary", "skills-installed", "esp-presets"].map(marker).join("\n\n") + "\n", "utf8");
    const api = service(projectPath);

    await api.readme.refresh("fixture");

    const generated = await readFile(readmePath, "utf8");
    const readmeBlocks = parseReadmeAutoBlocks(generated);
    const generatedAgents = await readFile(agentsPath, "utf8");
    const agentBlocks = parseReadmeAutoBlocks(generatedAgents);
    expect(generated.startsWith(userReadme)).toBe(true);
    expect(readmeBlocks.map(({ id }) => id)).toEqual(["workspace-map", "index-summary", "changelog"]);
    expect(generated).toContain("_site-index/catalog/skus.jsonl");
    expect(generated).not.toContain('id="task-routing"');
    expect(generatedAgents.startsWith(userAgents)).toBe(true);
    expect(agentBlocks.map(({ id }) => id)).toEqual(["agents-core", "task-routing", "data-guide", "design-summary", "skills-installed", "esp-presets"]);
    expect(agentBlocks.find(({ id }) => id === "data-guide")?.content).toContain("数据指南（_site-index/）");
    expect(agentBlocks.find(({ id }) => id === "skills-installed")?.content).toContain("demo-skill · 1.2.3");
    expect(agentBlocks.find(({ id }) => id === "esp-presets")?.content).toContain("mailchimp");
    expect(await api.inventory.dailyReport("fixture", "2026-10-19"))
      .toBe(await readFile(path.join(projectPath, paths.dailyReportsDir, "2026-10-19.md"), "utf8"));
    const before = await api.projects.get("fixture");
    await api.projects.updateConfig("fixture", { brand: { ...before.config.brand, tagline: "workspace" } });
    expect((await api.projects.get("fixture")).config.brand.tagline).toBe("workspace");
  }, 15_000);

  it("generates context-brief.md with read-only workspace asset inventory, category price bands and policies", async () => {
    const projectPath = await makeProject("workspace");
    const paths = pathsFor("workspace");
    const sitePath = path.join(projectPath, paths.site);
    const site = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
    site.workspace = { version: "1.0", sections: ["01-brand", "04-edm", "07-reports"], esp_presets: ["mailchimp"] };
    site.policies = { free_shipping_threshold: "Free shipping over $49", return_summary: "30-day free returns" };
    await writeFile(sitePath, JSON.stringify(site, null, 2), "utf8");
    await writeFile(path.join(projectPath, paths.index, "workspace.json"), JSON.stringify({
      version: "1.0",
      layout: "workspace",
      sections: [{ id: "brand", dir: "01-brand" }, { id: "edm", dir: "04-edm" }, { id: "reports", dir: "07-reports" }],
      paths: { "brand.facts": "01-brand" },
      esp_presets: ["mailchimp"],
    }), "utf8");
    await mkdir(path.join(projectPath, "01-brand", "sops"), { recursive: true });
    await mkdir(path.join(projectPath, "_outputs"), { recursive: true });
    await writeFile(path.join(projectPath, "01-brand", "sops", "voice-guide.md"), "# Brand Voice SOP\n\nKeep sentences concise.\n", "utf8");
    await writeFile(path.join(projectPath, "_outputs", "2026-10-21-fall-edm.draft.md"), "# Fall Birding Campaign Draft\n", "utf8");

    const api = service(projectPath);
    await api.readme.refresh("fixture");

    const brief = await readFile(path.join(projectPath, paths.contextBrief), "utf8");
    expect(brief).toContain("<!-- siteindex:generated:context-brief:v1 -->");
    expect(brief).toContain("## 1. 站点与品牌核心档案");
    expect(brief).toContain("Free shipping over $49 _[配置]_");
    expect(brief).toContain("30-day free returns _[配置]_");
    expect(brief).toContain("## 3. 工作区现有资产与待审清单（只读目录索引）");
    expect(brief).toContain("`_outputs/2026-10-21-fall-edm.draft.md`");
    expect(brief).toContain("Fall Birding Campaign Draft");
    expect(brief).toContain("`01-brand/sops/voice-guide.md`");
    expect(brief).toContain("Brand Voice SOP");
    expect(brief).toContain("## 4. 全站分类目录、价格带与导语摘要");
    expect(brief).toContain("## 5. 主推与代表性在售商品速查");
    expect(brief).toContain("## 6. 近期 EDM 活动与推品冷却期");
  }, 15_000);
});
