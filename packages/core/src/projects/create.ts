import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CSV_HEADERS,
  PATHS,
  SCHEMA_VERSION,
  type CreateProjectInput,
  type DetectResult,
  type SiteConfig,
} from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { writeCsv } from "../io/csv";

function createError(code: "PROJECT_NOT_FOUND" | "FOLDER_EXISTS" | "WRITE_FAILED" | "UNKNOWN", message: string, detail?: string) {
  return { code, message, ...(detail ? { detail } : {}) };
}

function cleanFolderName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    throw createError("UNKNOWN", "项目文件夹名称无效。", value);
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw createError("UNKNOWN", "项目文件夹名称是系统保留名称。", value);
  }
  return name;
}

async function templateDirectory(override?: string): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    override,
    path.resolve(process.cwd(), "templates/project"),
    path.resolve(moduleDirectory, "../../../../templates/project"),
    path.resolve(moduleDirectory, "../../../../../templates/project"),
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "README.md"));
      return candidate;
    } catch { /* 尝试下一个打包位置 */ }
  }
  throw createError("PROJECT_NOT_FOUND", "找不到项目模板目录。", candidates.join("; "));
}

async function copyTemplate(templatePath: string, projectPath: string, input: CreateProjectInput, detected: DetectResult): Promise<void> {
  const templateFiles = [PATHS.readme, PATHS.agentsMd, PATHS.claudeMd];
  const existing = new Set<string>();
  for (const name of templateFiles) {
    try { await access(path.join(projectPath, name)); existing.add(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await cp(templatePath, projectPath, {
    recursive: true, force: false, errorOnExist: false,
    filter: (source) => path.relative(templatePath, source) !== PATHS.aboutFile,
  });
  const replacements: Record<string, string> = {
    "{{brand_name}}": input.brand.name || detected.final_url,
    "{{domain}}": new URL(detected.final_url).hostname,
    "{{brand_tagline}}": input.brand.tagline ?? "",
    "{{base_url}}": detected.final_url,
    "{{platform}}": detected.platform,
    "{{markets}}": input.markets.join(", "),
    "{{brand_audience}}": input.brand.audience ?? "",
    "{{brand_voice}}": input.brand.voice ?? "",
  };
  for (const name of templateFiles) {
    if (existing.has(name)) continue;
    const filePath = path.join(projectPath, name);
    try {
      let content = await readFile(filePath, "utf8");
      for (const [placeholder, value] of Object.entries(replacements)) content = content.replaceAll(placeholder, value);
      if (name === PATHS.readme) {
        content = content.replace(/\n?<!-- siteindex:auto:start id="folder-map" -->[\s\S]*?<!-- siteindex:auto:end id="folder-map" -->\n?/u, "\n");
        content = content.replace(/^- 工作成果放入对应工作区文件夹，不要写入 `index\/`（台账除外，见下方数据指南）\r?\n/mu,
          "- 工作成果的存放位置由用户在此说明；不要写入 `index/`（台账除外，见下方数据指南）\n");
      }
      await atomicWrite(filePath, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function copySkills(templatePath: string, projectPath: string): Promise<void> {
  // 桌面安装包与源码仓库都把 skills/ 放在 templates/ 的同级目录。
  const sourceRoot = path.resolve(templatePath, "../../skills");
  let entries;
  try { entries = await readdir(sourceRoot, { withFileTypes: true }); }
  catch { throw createError("PROJECT_NOT_FOUND", "找不到软件内置 skills 目录。", sourceRoot); }
  const skills: { name: string; version: string }[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const source = path.join(sourceRoot, entry.name);
    let markdown: string;
    try { markdown = await readFile(path.join(source, "SKILL.md"), "utf8"); }
    catch { continue; }
    const version = /^version:\s*["']?([^\r\n"']+)/mu.exec(markdown)?.[1]?.trim() || "0.0.0";
    await cp(source, path.join(projectPath, PATHS.skillsDir, entry.name), { recursive: true, force: true });
    skills.push({ name: entry.name, version });
  }
  if (!skills.length) throw createError("PROJECT_NOT_FOUND", "软件内置 skills 目录为空。", sourceRoot);
  await atomicWrite(path.join(projectPath, PATHS.skillsManifest), `${JSON.stringify({ schema_version: "1.0", skills }, null, 2)}\n`);
}

function createConfig(input: CreateProjectInput, detected: DetectResult): SiteConfig {
  const finalUrl = new URL(detected.final_url);
  const domain = finalUrl.hostname.toLowerCase().replace(/^www\./, "");
  return {
    schema_version: SCHEMA_VERSION,
    domain,
    base_url: detected.final_url,
    platform: detected.platform,
    currency: detected.currency ?? "USD",
    locale: detected.locale ?? "en-US",
    timezone: "UTC",
    markets: [...input.markets],
    brand: {
      ...input.brand,
      name: input.brand.name.trim() || domain,
      voice: input.brand.voice ?? "",
      audience: input.brand.audience ?? "",
      usp: input.brand.usp ?? [],
    },
    sitemaps: detected.robots.sitemaps.length ? detected.robots.sitemaps : [new URL("/sitemap.xml", finalUrl).href],
    crawl: {
      adapter: "gmc_feed",
      feed_url: [...input.feed_urls],
      sku_field: input.sku_field.trim() || "id",
      category_depth: Math.max(1, Math.floor(input.category_depth || 1)),
      missing_as: input.missing_as,
      missing_removed_after_days: 30,
      max_removed_ratio: 0.1,
      rate_limit_ms: 1500,
      user_agent: "SiteIndex/1.0",
      stock_rules: {
        in_stock: ["add to cart", "in stock"],
        out_of_stock: ["sold out", "out of stock", "notify me"],
        preorder: ["pre-order", "preorder"],
      },
    } as SiteConfig["crawl"] & { stock_rules: { in_stock: string[]; out_of_stock: string[]; preorder: string[] } },
    categories: { mode: "feed" },
    workspace_folders: [], // shared 契约暂未删除；写入 site.json 时剔除。
    schedule: {
      daily: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "02:00" },
      validate: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "02:30" },
      weekly: { enabled: true, days: [1], time: "03:00" },
      readme: { enabled: true, days: [7], time: "05:00" },
      monthly: { enabled: true, day_of_month: 1, time: "04:00" },
      options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: true },
    },
  };
}

async function initializeProjectData(projectPath: string, config: SiteConfig): Promise<void> {
  const jsonlFiles = [
    PATHS.skus, PATHS.productDetails, PATHS.inventoryLatest, PATHS.seoPages, PATHS.seoIssues,
    PATHS.seoLinks, PATHS.blogIndex, PATHS.keywords, PATHS.edmCampaigns, PATHS.outreach,
    PATHS.productsView, PATHS.skuStockView, PATHS.runs,
  ];
  const directories = new Set<string>([
    PATHS.index, PATHS.eventsDir, PATHS.dailyReportsDir, PATHS.weeklyReportsDir, PATHS.archiveDir,
    PATHS.designScreenshots, PATHS.jobLogsDir,
    ...jsonlFiles.map((file) => path.posix.dirname(file)),
    path.posix.dirname(PATHS.dailySummary),
    path.posix.dirname(PATHS.skuMedia),
    path.posix.dirname(PATHS.skuTags),
    path.posix.dirname(PATHS.categories),
    path.posix.dirname(PATHS.site),
    path.posix.dirname(PATHS.sitemapsSummary),
  ]);
  await Promise.all([...directories].map((directory) => mkdir(path.join(projectPath, directory), { recursive: true })));

  const sitePath = path.join(projectPath, PATHS.site);
  try {
    await access(sitePath);
    throw createError("FOLDER_EXISTS", "目标目录已经包含 SiteIndex 项目配置。", sitePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await Promise.all([
    atomicWrite(sitePath, `${JSON.stringify(config, (key, value) => key === "workspace_folders" ? undefined : value, 2)}\n`),
    ...jsonlFiles.map((relative) => atomicWrite(path.join(projectPath, relative), "")),
    writeCsv(path.join(projectPath, PATHS.dailySummary), [], CSV_HEADERS.dailySummary, ["date", "category"]),
    writeCsv(path.join(projectPath, PATHS.skuMedia), [], CSV_HEADERS.skuMedia, ["sku", "image_role"]),
    writeCsv(path.join(projectPath, PATHS.skuTags), [], CSV_HEADERS.skuTags, ["sku"]),
    atomicWrite(path.join(projectPath, PATHS.categories), "[]\n"),
    atomicWrite(path.join(projectPath, PATHS.sitemapsSummary), `${JSON.stringify({ sitemaps: config.sitemaps }, null, 2)}\n`),
    atomicWrite(path.join(projectPath, PATHS.tech), `${JSON.stringify({ platform: config.platform, frontend: null }, null, 2)}\n`),
  ]);
}

export interface CreatedProject {
  id: string;
  path: string;
  config: SiteConfig;
}

/** 按 DATA_SPEC 1.1 初始化项目目录，不覆盖已存在的项目文件。 */
export async function createProjectFiles(
  input: CreateProjectInput,
  detected: DetectResult,
  templatePath?: string,
): Promise<CreatedProject> {
  const folderName = cleanFolderName(input.folder_name);
  const root = path.resolve(input.projects_root);
  const projectPath = path.resolve(root, folderName);
  const relative = path.relative(root, projectPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw createError("UNKNOWN", "项目目录必须位于 projects_root 内。", projectPath);
  }
  await mkdir(root, { recursive: true });
  let existingEntries: string[] = [];
  try { existingEntries = await readdir(projectPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existingEntries.includes(PATHS.site.split("/").at(-1) ?? "site.json")
    || existingEntries.includes(PATHS.index.split("/")[0]!)) {
    throw createError("FOLDER_EXISTS", "目标目录已经包含 SiteIndex 项目数据。", projectPath);
  }

  try {
    await mkdir(projectPath, { recursive: true });
    const template = await templateDirectory(templatePath);
    await copyTemplate(template, projectPath, input, detected);
    const config = createConfig(input, detected);
    await initializeProjectData(projectPath, config);
    await copySkills(template, projectPath);
    return { id: folderName, path: projectPath, config };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw createError("WRITE_FAILED", "创建项目文件失败。", error instanceof Error ? error.message : String(error));
  }
}
