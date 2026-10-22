import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CSV_HEADERS,
  DEFAULT_WORKSPACE_FOLDERS,
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
  await cp(templatePath, projectPath, { recursive: true, force: false, errorOnExist: false });
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
  for (const name of [PATHS.readme, PATHS.agentsMd, PATHS.claudeMd, PATHS.aboutFile]) {
    const filePath = path.join(projectPath, name);
    try {
      let content = await readFile(filePath, "utf8");
      for (const [placeholder, value] of Object.entries(replacements)) content = content.replaceAll(placeholder, value);
      await atomicWrite(filePath, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createConfig(input: CreateProjectInput, detected: DetectResult): SiteConfig {
  const finalUrl = new URL(detected.final_url);
  const domain = finalUrl.hostname.toLowerCase().replace(/^www\./, "");
  const workspaceNames = [...new Set(input.workspace_folders.map((name) => name.trim()).filter(Boolean))];
  const workspace_folders = workspaceNames.map((name) => ({
    name,
    default: (DEFAULT_WORKSPACE_FOLDERS as readonly string[]).includes(name),
  }));
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
    workspace_folders,
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
    atomicWrite(sitePath, `${JSON.stringify(config, null, 2)}\n`),
    ...jsonlFiles.map((relative) => atomicWrite(path.join(projectPath, relative), "")),
    writeCsv(path.join(projectPath, PATHS.dailySummary), [], CSV_HEADERS.dailySummary, ["date", "category"]),
    writeCsv(path.join(projectPath, PATHS.skuMedia), [], CSV_HEADERS.skuMedia, ["sku", "image_role"]),
    writeCsv(path.join(projectPath, PATHS.skuTags), [], CSV_HEADERS.skuTags, ["sku"]),
    atomicWrite(path.join(projectPath, PATHS.categories), "[]\n"),
    atomicWrite(path.join(projectPath, PATHS.sitemapsSummary), `${JSON.stringify({ sitemaps: config.sitemaps }, null, 2)}\n`),
    atomicWrite(path.join(projectPath, PATHS.tech), `${JSON.stringify({ platform: config.platform, frontend: null }, null, 2)}\n`),
    ...config.workspace_folders.map(async (folder) => {
      const folderPath = path.join(projectPath, folder.name);
      await mkdir(folderPath, { recursive: true });
      const about = path.join(folderPath, PATHS.aboutFile);
      try { await access(about); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWrite(about, "待补充说明\n");
      }
    }),
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
    return { id: folderName, path: projectPath, config };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw createError("WRITE_FAILED", "创建项目文件失败。", error instanceof Error ? error.message : String(error));
  }
}
