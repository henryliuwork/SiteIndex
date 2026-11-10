import { lstat, mkdir, open, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CSV_HEADERS,
  pathsFor,
  type CreateProjectInput,
  type DetectResult,
  type SiteConfig,
  type WorkspaceCreateInput,
  type WorkspaceCreateResult,
} from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { normalizeSiteDomain } from "../projects/create-guard";
import { createConfig } from "../projects/create";

interface WorkspaceSection {
  id: string;
  dir: string;
}

interface WorkspaceManifest {
  version: string;
  layout: "workspace";
  sections: WorkspaceSection[];
  paths: Record<string, string>;
  esp_presets: string[];
}

interface SkillManifestEntry {
  name: string;
  version: string;
}

interface WorkspaceCreateOptions {
  templateDir?: string;
  siteConfig?: SiteConfig;
  baseUrl?: string;
}

const IGNORED_ENTRY_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const PRESET_PATTERN = /^[a-z0-9-]+$/u;

function workspaceError(
  code: "WORKSPACE_NOT_EMPTY" | "PROJECT_NOT_FOUND" | "PROJECT_UNREADABLE" | "CONFIG_INVALID" | "WRITE_FAILED",
  message: string,
  detail?: string,
) {
  return Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifestSection(value: unknown): value is WorkspaceSection {
  return isRecord(value) && typeof value.id === "string" && typeof value.dir === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isWorkspaceManifest(value: unknown): value is WorkspaceManifest {
  return isRecord(value)
    && typeof value.version === "string"
    && value.layout === "workspace"
    && Array.isArray(value.sections)
    && value.sections.every(isManifestSection)
    && isStringRecord(value.paths)
    && Array.isArray(value.esp_presets)
    && value.esp_presets.every((item) => typeof item === "string");
}

function normalizePresetId(value: string, supportedIds: readonly string[]): string {
  const canonical = value.startsWith("esp.") ? value.slice("esp.".length) : value;
  if (!PRESET_PATTERN.test(canonical) || !supportedIds.includes(canonical)) {
    throw workspaceError("CONFIG_INVALID", "所选 EDM 预设不受支持，或不在工作区模板清单中。", value);
  }
  return canonical;
}

function resolveTarget(targetDir: string): string {
  const target = path.resolve(targetDir);
  if (!targetDir.trim() || target === path.parse(target).root) {
    throw workspaceError("CONFIG_INVALID", "工作区目录无效，请选择一个项目文件夹。", targetDir);
  }
  return target;
}

function ignoredEntry(name: string): boolean {
  return name.toLowerCase() === ".git" || IGNORED_ENTRY_NAMES.has(name.toLowerCase());
}

async function assertTargetEmpty(target: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw workspaceError("PROJECT_UNREADABLE", "无法检查工作区目录。", target);
  }
  const invalidEntries = entries
    .filter((entry) => !ignoredEntry(entry.name))
    .map((entry) => entry.name)
    .sort(compareKeys);
  if (invalidEntries.length) {
    throw workspaceError("WORKSPACE_NOT_EMPTY", "目标目录不是空目录。请改选空目录；未覆盖任何已有内容。", invalidEntries.slice(0, 10).join(", "));
  }
}

async function findTemplate(templateDir?: string): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    templateDir ? path.resolve(templateDir, "../workspace") : undefined,
    path.resolve(process.cwd(), "templates/workspace"),
    path.resolve(moduleDirectory, "../../../../templates/workspace"),
    path.resolve(moduleDirectory, "../../../../../templates/workspace"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await readFile(path.join(candidate, "README.md"), "utf8");
      await readFile(path.join(candidate, "_site-index", "workspace.json"), "utf8");
      return candidate;
    } catch { /* 尝试下一个开发或打包路径 */ }
  }
  throw workspaceError("PROJECT_NOT_FOUND", "找不到 Agent 工作区模板目录。", candidates.join("; "));
}

async function loadManifest(templateDir: string): Promise<WorkspaceManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(templateDir, "_site-index", "workspace.json"), "utf8"));
  } catch (error) {
    throw workspaceError("CONFIG_INVALID", "工作区模板的 workspace.json 无法读取。", error instanceof Error ? error.message : String(error));
  }
  if (!isWorkspaceManifest(value)) throw workspaceError("CONFIG_INVALID", "工作区模板的 workspace.json 格式无效。");
  return value;
}

function configPlatform(platform: WorkspaceCreateInput["platform"]): SiteConfig["platform"] {
  return platform === "magento2" ? "magento" : platform;
}

function platformLabel(platform: SiteConfig["platform"]): string {
  const labels: Record<SiteConfig["platform"], string> = {
    magento: "Magento 2",
    wordpress: "WordPress",
    woocommerce: "WooCommerce",
    shopify: "Shopify",
    other: "其他平台",
  };
  return labels[platform];
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw workspaceError("CONFIG_INVALID", "网站地址无效。", value);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw workspaceError("CONFIG_INVALID", "网站地址必须是有效的 HTTP 或 HTTPS 地址。", value);
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

function configFor(
  input: WorkspaceCreateInput,
  manifest: WorkspaceManifest,
  domain: string,
  baseUrl: string,
): SiteConfig {
  const inputForConfig: CreateProjectInput = {
    url: baseUrl,
    feed_urls: [],
    sku_field: "id",
    category_depth: 1,
    missing_as: "out_of_stock",
    brand: input.brand,
    markets: [...(input.markets ?? [])],
    projects_root: path.dirname(input.targetDir),
    folder_name: path.basename(input.targetDir),
    workspace_folders: [],
  };
  const detected: DetectResult = {
    input: baseUrl,
    final_url: baseUrl,
    redirect_status: null,
    robots: { found: false, disallow_count: 0, sitemaps: [] },
    sitemaps: [],
    total_urls: 0,
    platform: configPlatform(input.platform),
    platform_evidence: "workspace template",
    frontend: null,
    locale: null,
    currency: null,
    feed_candidates: [],
  };
  const config = createConfig(inputForConfig, detected);
  return {
    ...config,
    domain,
    workspace: {
      version: manifest.version,
      sections: manifest.sections.map((section) => section.dir),
      esp_presets: [...manifest.esp_presets],
    },
  };
}

function withWorkspaceMetadata(config: SiteConfig, manifest: WorkspaceManifest, domain: string): SiteConfig {
  return {
    ...config,
    domain,
    workspace: {
      version: manifest.version,
      sections: manifest.sections.map((section) => section.dir),
      esp_presets: [...manifest.esp_presets],
    },
    workspace_folders: [],
  };
}

function replaceAutoBlock(text: string, id: string, body: string): string {
  const startMarker = '<!-- siteindex:auto:start id="' + id + '" -->';
  const endMarker = '<!-- siteindex:auto:end id="' + id + '" -->';
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < start) throw workspaceError("CONFIG_INVALID", "工作区模板缺少自动区块标记。", id);
  return text.slice(0, start + startMarker.length) + "\n" + body.trim() + "\n" + text.slice(end);
}

function replaceVariables(text: string, config: SiteConfig): string {
  const values: Record<string, string> = {
    brand_name: config.brand.name,
    domain: config.domain,
    base_url: config.base_url,
    platform_label: platformLabel(config.platform),
    markets: (config.markets ?? []).join(", "),
    created_at: new Date().toISOString().slice(0, 10),
  };
  return Object.entries(values).reduce(
    (output, [key, value]) => output.split("{{" + key + "}}").join(value),
    text,
  );
}

function autoBlocks(manifest: WorkspaceManifest, config: SiteConfig, skills: readonly SkillManifestEntry[]) {
  const workspacePaths = Object.entries(manifest.paths).sort(([left], [right]) => compareKeys(left, right));
  const workspaceMap = [
    "### 工作区板块",
    ...manifest.sections.map((section) => "- " + section.dir),
    "",
    "### 常用路径",
    ...workspacePaths.map(([key, value]) => "- " + key + " → " + value),
  ].join("\n");
  const dataGuide = [
    "| 路径 | 内容 |",
    "|---|---|",
    "| " + pathsFor("workspace").site + " | 站点配置与抓取设置 |",
    "| " + pathsFor("workspace").skus + " | SKU 主表 |",
    "| " + pathsFor("workspace").inventoryLatest + " | 当前库存 |",
    "| " + pathsFor("workspace").dailySummary + " | 库存历史汇总 |",
    "| " + pathsFor("workspace").seoPages + " | SEO 页面 |",
    "| " + pathsFor("workspace").seoIssues + " | SEO 问题 |",
    "| " + pathsFor("workspace").blogIndex + " | 博客索引 |",
  ].join("\n");
  return {
    readme: {
      "workspace-map": workspaceMap,
      "index-summary": "尚无索引数据。完成首次同步后，SiteIndex 会更新此处的数据概况。",
      changelog: "暂无同步记录。",
    },
    agents: {
      "agents-core": "项目：" + config.brand.name + "（" + config.domain + "）。SiteIndex 数据统一位于 " + pathsFor("workspace").index + "/。不要读取或输出根目录 .env 内容。",
      "task-routing": "开始任务前先读对应板块的 README.md；待审产物放入 _outputs/。",
      "data-guide": dataGuide,
      "design-summary": "尚未提取设计规范。",
      "skills-installed": skills.map((skill) => "- " + skill.name + " · " + skill.version).join("\n") || "暂无技能。",
      "esp-presets": manifest.esp_presets.map((preset) => "- " + preset).join("\n") || "暂无渠道预设。",
    },
  };
}

async function listSkills(templateDir: string): Promise<{ root: string; entries: SkillManifestEntry[] }> {
  const root = path.resolve(templateDir, "../../skills");
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch {
    throw workspaceError("PROJECT_NOT_FOUND", "找不到软件内置 skills 目录。", root);
  }
  const entries: SkillManifestEntry[] = [];
  for (const child of children.filter((entry) => entry.isDirectory()).sort((left, right) => compareKeys(left.name, right.name))) {
    if (child.name === "edm-builder") continue;
    try {
      const markdown = await readFile(path.join(root, child.name, "SKILL.md"), "utf8");
      const version = /^version:\s*["']?([^"'\r\n]+)/mu.exec(markdown)?.[1]?.trim() || "0.0.0";
      entries.push({ name: child.name, version });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!entries.length) throw workspaceError("PROJECT_NOT_FOUND", "软件内置 skills 目录为空。", root);
  return { root, entries };
}

async function ensureDirectory(directory: string, target: string, createdDirectories: string[]): Promise<void> {
  const relative = path.relative(target, directory);
  if (!relative || relative === ".") return;
  const parent = path.dirname(directory);
  if (parent !== directory) await ensureDirectory(parent, target, createdDirectories);
  try {
    await mkdir(directory);
    createdDirectories.push(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw workspaceError("WORKSPACE_NOT_EMPTY", "工作区中存在同名非目录，未覆盖任何内容。", directory);
    }
  }
}

async function writeExclusive(filePath: string, content: string | Uint8Array, createdFiles: string[]): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw workspaceError("WORKSPACE_NOT_EMPTY", "工作区创建期间发现同名文件，未覆盖任何内容。", filePath);
    }
    throw error;
  }
  createdFiles.push(filePath);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function workspacePath(relative: string, paths: ReturnType<typeof pathsFor>): string {
  return relative === "_site-index" ? paths.index
    : relative.startsWith("_site-index/") ? path.posix.join(paths.index, relative.slice("_site-index/".length))
      : relative;
}

async function copyTemplate(
  templateDir: string,
  target: string,
  paths: ReturnType<typeof pathsFor>,
  manifest: WorkspaceManifest,
  config: SiteConfig,
  skills: readonly SkillManifestEntry[],
  createdFiles: string[],
  createdDirectories: string[],
): Promise<void> {
  const blocks = autoBlocks(manifest, config, skills);
  const visit = async (sourceDir: string, relativeDir: string): Promise<void> => {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    entries.sort((left, right) => compareKeys(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDir ? relativeDir + "/" + entry.name : entry.name;
      if (relative === "presets" || relative.startsWith("presets/")) continue;
      if (relative === "_site-index/skills/manifest.json") continue;
      const destination = path.join(target, workspacePath(relative, paths));
      const source = path.join(sourceDir, entry.name);
      if (entry.isDirectory()) {
        await ensureDirectory(destination, target, createdDirectories);
        await visit(source, relative);
      } else if (entry.isFile()) {
        if (relative === "_site-index/workspace.json") {
          await writeExclusive(destination, JSON.stringify(manifest, null, 2) + "\n", createdFiles);
          continue;
        }
        let text = replaceVariables(await readFile(source, "utf8"), config);
        if (relative === "README.md") {
          for (const [id, body] of Object.entries(blocks.readme)) text = replaceAutoBlock(text, id, body);
        } else if (relative === "AGENTS.md") {
          for (const [id, body] of Object.entries(blocks.agents)) text = replaceAutoBlock(text, id, body);
        }
        await writeExclusive(destination, text, createdFiles);
      }
    }
  };
  await visit(templateDir, "");
}

async function copySkill(
  sourceDir: string,
  targetDir: string,
  target: string,
  createdFiles: string[],
  createdDirectories: string[],
): Promise<void> {
  await ensureDirectory(targetDir, target, createdDirectories);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((left, right) => compareKeys(left.name, right.name));
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySkill(source, destination, target, createdFiles, createdDirectories);
    } else if (entry.isFile()) {
      await writeExclusive(destination, await readFile(source), createdFiles);
    }
  }
}

async function initializeData(
  target: string,
  paths: ReturnType<typeof pathsFor>,
  config: SiteConfig,
  createdFiles: string[],
  createdDirectories: string[],
): Promise<void> {
  const jsonlFiles = [
    paths.skus, paths.productDetails, paths.inventoryLatest, paths.seoPages, paths.seoIssues, paths.seoLinks,
    paths.blogIndex, paths.keywords, paths.edmCampaigns, paths.outreach, paths.productsView, paths.skuStockView, paths.runs,
  ];
  const jsonFiles = [
    [paths.categories, "[]\n"],
    [paths.sitemapsSummary, JSON.stringify({ sitemaps: config.sitemaps }, null, 2) + "\n"],
    [paths.tech, JSON.stringify({ platform: config.platform, frontend: null }, null, 2) + "\n"],
  ] as const;
  const directories = new Set([
    paths.index, paths.eventsDir, paths.dailyReportsDir, paths.weeklyReportsDir, paths.archiveDir,
    paths.designScreenshots, paths.jobLogsDir,
    ...jsonlFiles.map((file) => path.posix.dirname(file)),
    ...jsonFiles.map(([file]) => path.posix.dirname(file)),
    path.posix.dirname(paths.dailySummary), path.posix.dirname(paths.skuMedia), path.posix.dirname(paths.skuTags),
  ]);
  for (const relative of [...directories].sort((left, right) => left.split("/").length - right.split("/").length || compareKeys(left, right))) {
    await ensureDirectory(path.join(target, relative), target, createdDirectories);
  }
  for (const relative of jsonlFiles) await writeExclusive(path.join(target, relative), "", createdFiles);
  for (const [relative, content] of jsonFiles) await writeExclusive(path.join(target, relative), content, createdFiles);
  await writeExclusive(path.join(target, paths.dailySummary), CSV_HEADERS.dailySummary.join(",") + "\n", createdFiles);
  await writeExclusive(path.join(target, paths.skuMedia), CSV_HEADERS.skuMedia.join(",") + "\n", createdFiles);
  await writeExclusive(path.join(target, paths.skuTags), CSV_HEADERS.skuTags.join(",") + "\n", createdFiles);
  await writeExclusive(
    path.join(target, paths.site),
    JSON.stringify(config, (key, value: unknown) => key === "workspace_folders" ? undefined : value, 2) + "\n",
    createdFiles,
  );
}

async function cleanup(files: readonly string[], directories: readonly string[]): Promise<void> {
  for (const file of [...files].reverse()) await unlink(file).catch(() => undefined);
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await rmdir(directory).catch(() => undefined);
  }
}

/** 初始化完整工作区；任何失败都只回滚本次创建的项目内容。 */
export async function createWorkspaceFiles(
  input: WorkspaceCreateInput,
  options: WorkspaceCreateOptions = {},
): Promise<WorkspaceCreateResult> {
  const target = resolveTarget(input.targetDir);
  const domain = normalizeSiteDomain(input.domain);
  if (!domain) throw workspaceError("CONFIG_INVALID", "网站域名无效。", input.domain);
  await assertTargetEmpty(target);
  const templateDir = await findTemplate(options.templateDir);
  const sourceManifest = await loadManifest(templateDir);
  const selectedPresets = [...new Set(input.esp_presets.map((preset) => normalizePresetId(preset, sourceManifest.esp_presets)))].sort(compareKeys);
  for (const preset of selectedPresets) {
    try {
      await readFile(path.join(templateDir, "presets", "esp." + preset + ".md"), "utf8");
    } catch {
      throw workspaceError("CONFIG_INVALID", "所选 EDM 预设不在软件模板中。", preset);
    }
  }
  const manifest: WorkspaceManifest = { ...sourceManifest, esp_presets: selectedPresets };
  const skillSet = await listSkills(templateDir);
  const paths = pathsFor("workspace");
  const baseUrl = options.siteConfig?.base_url
    ?? (options.baseUrl ? normalizeBaseUrl(options.baseUrl) : normalizeBaseUrl(input.domain));
  const config = withWorkspaceMetadata(
    options.siteConfig ?? configFor(input, manifest, domain, baseUrl),
    manifest,
    domain,
  );
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  let createdTarget = false;
  try {
    try {
      await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await mkdir(target);
        createdTarget = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") {
          throw workspaceError("WORKSPACE_NOT_EMPTY", "工作区创建期间目录已被其他操作占用。", target);
        }
        throw mkdirError;
      }
    }
    const rootInfo = await lstat(target);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw workspaceError("WORKSPACE_NOT_EMPTY", "目标路径不是普通文件夹。", target);
    }
    const indexRoot = path.join(target, paths.index);
    try {
      await mkdir(indexRoot);
      createdDirectories.push(indexRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw workspaceError("WORKSPACE_NOT_EMPTY", "工作区创建期间数据目录已被其他操作占用。", indexRoot);
      }
      throw error;
    }

    await copyTemplate(templateDir, target, paths, manifest, config, skillSet.entries, createdFiles, createdDirectories);
    for (const skill of skillSet.entries) {
      await copySkill(
        path.join(skillSet.root, skill.name),
        path.join(target, paths.skillsDir, skill.name),
        target,
        createdFiles,
        createdDirectories,
      );
    }
    await writeExclusive(
      path.join(target, paths.skillsManifest),
      JSON.stringify({ schema_version: "1.0", skills: skillSet.entries }, null, 2) + "\n",
      createdFiles,
    );
    for (const preset of selectedPresets) {
      const fileName = "esp." + preset + ".md";
      const presetTarget = path.join(target, paths.skillsDir, "presets", fileName);
      await ensureDirectory(path.dirname(presetTarget), target, createdDirectories);
      await writeExclusive(
        presetTarget,
        await readFile(path.join(templateDir, "presets", fileName)),
        createdFiles,
      );
    }
    await writeExclusive(path.join(target, ".env"), "wp_base_url=\nwp_username=\nwp_app_password=\n", createdFiles);
    await ensureDirectory(path.join(target, "_tmp"), target, createdDirectories);
    await writeExclusive(path.join(target, "_tmp", "README.md"), "此目录用于临时处理中间文件。\n", createdFiles);
    await initializeData(target, paths, config, createdFiles, createdDirectories);

    const created = [...createdDirectories, ...createdFiles]
      .map((absolute) => absolute.slice(target.length + 1).split(path.sep).join("/"))
      .sort(compareKeys);
    return { path: target, created };
  } catch (error) {
    await cleanup(createdFiles, createdDirectories);
    if (createdTarget) await rmdir(target).catch(() => undefined);
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw workspaceError("WRITE_FAILED", "创建工作区失败；本次创建的文件已回滚。", error instanceof Error ? error.message : String(error));
  }
}

