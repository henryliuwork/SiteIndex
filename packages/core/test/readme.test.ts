import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS, type DesignTokens } from "@siteindex/shared";
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

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-readme-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
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
  "folder-map": "## 目录地图",
  "task-routing": "## 任务路由",
  "data-guide": "## 数据指南",
  "design-summary": "## 设计规范速览",
  changelog: "## 变更记录",
};

describe("README automatic blocks", () => {
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
      new Set(["index-summary", "folder-map", "task-routing", "data-guide", "design-summary"]),
    );
    expect(updated).toBe(
      '用户区块含有 $& 和 CRLF\r\n<!-- siteindex:auto:start id="changelog" -->\n新内容含有 $&\n<!-- siteindex:auto:end id="changelog" -->\r\n尾部用户内容\r\n',
    );
  });

  it("appends missing blocks in canonical order, respects disabled blocks and rejects malformed markers", () => {
    const output = replaceReadmeAutoBlocks("用户维护的 README。\n", emptyContents, new Set(["folder-map"]));
    expect(parseReadmeAutoBlocks(output).map(({ id }) => id)).toEqual([
      "index-summary", "task-routing", "data-guide", "design-summary", "changelog",
    ]);
    expect(output).toContain("用户维护的 README。\n\n<!-- siteindex:auto:start id=\"index-summary\" -->");
    expect(() => parseReadmeAutoBlocks('<!-- siteindex:auto:start id="folder-map" -->\n内容\n<!-- siteindex:auto:end id="task-routing" -->'))
      .toThrow("README 自动区块标记未成对或存在嵌套。");
    expect(() => parseReadmeAutoBlocks('<!-- siteindex:auto:start id=folder-map -->'))
      .toThrow("README 自动区块标记未成对或存在嵌套。");
  });

  it("builds all six data-driven blocks from site, inventory, folders, design and run records", () => {
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
      folders: [{ name: "edm", description: "Campaign work", default: true, files: 2, modified_at: "2026-10-20T12:00:00Z" }],
      designTokens: tokens,
      runs: [{ run_id: "run-1", job: "daily", started_at: "2026-10-21T02:04:00-07:00", finished_at: null, status: "ok" }],
    };
    const blocks = buildReadmeAutoContent(input);
    expect(Object.keys(blocks)).toEqual(Object.keys(emptyContents));
    expect(blocks["index-summary"]).toContain("在售 SKU / 产品 | 8 / 4");
    expect(blocks["index-summary"]).toContain("85.0%（较 7 天前 +5.0pt）");
    expect(blocks["index-summary"]).toContain("新到货 1 · 新缺货 1 · 调价 1 · 上新 1");
    expect(blocks["folder-map"]).toContain("`edm/` | Campaign work | 2 | 2026-10-20");
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
    expect(generated).toContain("| 文件夹 | 用途 | 文件数 | 最近修改 |");
    expect(generated).toContain("## 任务路由");
    expect(generated).toContain("## 数据指南（index/）");
    expect(generated).toContain("## 设计规范速览");
    expect((await api.readme.get("fixture")).auto_blocks.map(({ id }) => id)).toEqual(Object.keys(emptyContents));
  }, 15_000);
});
