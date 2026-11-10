import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSV_HEADERS, PATHS, pathsFor, type SiteConfig, type WorkspaceImportCheckResult, type WorkspaceImportIssue } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";
import { parseReadmeAutoBlocks } from "../readme";
import { validateProjectFiles } from "../validate";

interface WorkspaceManifest {
  version: string;
  layout: "workspace";
  sections: { id: string; dir: string }[];
  paths: Record<string, string>;
  esp_presets: string[];
}

const REQUIRED_BLOCKS: Record<string, readonly string[]> = {
  [PATHS.readme]: ["workspace-map", "index-summary", "changelog"],
  [PATHS.agentsMd]: ["agents-core", "task-routing", "data-guide", "design-summary", "skills-installed", "esp-presets"],
};
const EMPTY_LEDGER_CONTENT: Readonly<Record<string, string>> = {
  [pathsFor("workspace").keywords]: "",
  [pathsFor("workspace").skuMedia]: `${CSV_HEADERS.skuMedia.join(",")}\n`,
  [pathsFor("workspace").skuTags]: `${CSV_HEADERS.skuTags.join(",")}\n`,
  [pathsFor("workspace").edmCampaigns]: "",
  [pathsFor("workspace").outreach]: "",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validManifest(value: unknown): value is WorkspaceManifest {
  return record(value)
    && typeof value.version === "string"
    && value.layout === "workspace"
    && Array.isArray(value.sections)
    && value.sections.every((section) => record(section) && typeof section.id === "string" && typeof section.dir === "string")
    && record(value.paths)
    && Object.values(value.paths).every((entry) => typeof entry === "string")
    && Array.isArray(value.esp_presets)
    && value.esp_presets.every((entry) => typeof entry === "string");
}

function validWorkspaceConfig(value: unknown): value is NonNullable<SiteConfig["workspace"]> {
  return record(value)
    && typeof value.version === "string"
    && Array.isArray(value.sections)
    && value.sections.every((entry) => typeof entry === "string")
    && Array.isArray(value.esp_presets)
    && value.esp_presets.every((entry) => typeof entry === "string");
}

function workspaceTemplateCandidates(templateDir?: string): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    templateDir ? path.resolve(templateDir, "../workspace") : undefined,
    path.resolve(process.cwd(), "templates/workspace"),
    path.resolve(moduleDirectory, "../../../../templates/workspace"),
    path.resolve(moduleDirectory, "../../../../../templates/workspace"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function loadWorkspaceTemplate(templateDir?: string): Promise<{ root: string; manifest: WorkspaceManifest; files: Map<string, string> }> {
  const candidates = workspaceTemplateCandidates(templateDir);
  for (const root of candidates) {
    try {
      const [manifestText, readme, agents] = await Promise.all([
        readFile(path.join(root, "_site-index", "workspace.json"), "utf8"),
        readFile(path.join(root, PATHS.readme), "utf8"),
        readFile(path.join(root, PATHS.agentsMd), "utf8"),
      ]);
      const manifestValue: unknown = JSON.parse(manifestText);
      if (!validManifest(manifestValue)) continue;
      return { root, manifest: manifestValue, files: new Map([[PATHS.readme, readme], [PATHS.agentsMd, agents]]) };
    } catch { /* 尝试源码树或安装包中的下一个模板位置。 */ }
  }
  throw new Error("找不到有效的 Agent 工作区模板。");
}

function metadataFromManifest(manifest: WorkspaceManifest): NonNullable<SiteConfig["workspace"]> {
  return {
    version: manifest.version,
    sections: manifest.sections.map((section) => section.dir),
    esp_presets: [...manifest.esp_presets],
  };
}

function manifestForConfig(template: WorkspaceManifest, workspace: SiteConfig["workspace"]): WorkspaceManifest {
  if (!workspace) return template;
  const dirs = new Set(workspace.sections);
  const sections = template.sections.filter((section) => dirs.has(section.dir));
  for (const dir of workspace.sections) {
    if (!sections.some((section) => section.dir === dir)) sections.push({ id: dir, dir });
  }
  return { ...template, version: workspace.version, sections, esp_presets: [...workspace.esp_presets] };
}

function autoBlockIssue(file: string, id: string): WorkspaceImportIssue {
  return { path: file, code: `missing_auto_block:${id}`, message: `缺少自动区块「${id}」。`, auto_fixable: true };
}

async function exclusiveWrite(filePath: string, contents: string): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });
  let handle;
  try {
    handle = await open(filePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  return true;
}

function emptyTemplateDoc(templateText: string, config: Record<string, unknown>): string {
  const platformLabels: Record<SiteConfig["platform"], string> = {
    magento: "Magento 2", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台",
  };
  const brand = record(config.brand) ? config.brand : {};
  const platform = (["magento", "wordpress", "woocommerce", "shopify", "other"] as const)
    .find((candidate) => candidate === config.platform) ?? "other";
  const markets = Array.isArray(config.markets) ? config.markets.filter((market): market is string => typeof market === "string") : [];
  const replacements: Record<string, string> = {
    "{{brand_name}}": typeof brand.name === "string" ? brand.name : "",
    "{{domain}}": typeof config.domain === "string" ? config.domain : "",
    "{{base_url}}": typeof config.base_url === "string" ? config.base_url : "",
    "{{platform_label}}": platformLabels[platform],
    "{{markets}}": markets.join(", "),
    "{{created_at}}": new Date().toISOString().slice(0, 10),
  };
  return Object.entries(replacements).reduce((text, [token, value]) => text.replaceAll(token, value), templateText);
}

async function inspectWorkspace(projectPath: string): Promise<{
  issues: WorkspaceImportIssue[];
  config?: Record<string, unknown>;
  configSource?: string;
  manifest?: WorkspaceManifest;
}> {
  const paths = pathsFor("workspace");
  const configPath = path.join(projectPath, paths.site);
  let configSource: string;
  try { configSource = await readFile(configPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { issues: [{ path: paths.site, code: "workspace_config_missing", message: "找不到工作区数据目录中的 site.json。", auto_fixable: false }] };
    }
    throw error;
  }
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(configSource);
    if (!record(parsed)) throw new Error("site.json 顶层必须是对象。");
    config = parsed;
  } catch (error) {
    return { issues: [{ path: paths.site, code: "workspace_config_invalid", message: `site.json 无法解析：${error instanceof Error ? error.message : String(error)}`, auto_fixable: false }] };
  }

  const issues: WorkspaceImportIssue[] = [];
  const manifestPath = path.posix.join(paths.index, "workspace.json");
  let manifest: WorkspaceManifest | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(path.join(projectPath, manifestPath), "utf8"));
    if (validManifest(value)) manifest = value;
    else issues.push({ path: manifestPath, code: "workspace_manifest_invalid", message: "workspace.json 格式无效，请手动检查。", auto_fixable: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      issues.push({ path: manifestPath, code: "workspace_manifest_missing", message: "缺少工作区路径映射文件 workspace.json。", auto_fixable: true });
    } else {
      issues.push({ path: manifestPath, code: "workspace_manifest_invalid", message: `workspace.json 无法解析：${error instanceof Error ? error.message : String(error)}`, auto_fixable: false });
    }
  }

  if (config.workspace === undefined) {
    issues.push({ path: paths.site, code: "workspace_metadata_missing", message: "site.json 缺少 workspace 元数据。", auto_fixable: true });
  } else if (!validWorkspaceConfig(config.workspace)) {
    issues.push({ path: paths.site, code: "workspace_metadata_invalid", message: "site.json 的 workspace 字段格式无效，请手动检查。", auto_fixable: false });
  }

  const report = await validateProjectFiles(projectPath, { writeReport: false });
  for (const file of report.files) {
    if (!["config", "sync", "ledger", "view"].includes(file.kind)) continue;
    if (file.status === "ok" || file.rule === "stale") continue;
    const missingLedger = file.kind === "ledger" && file.status === "missing";
    const code = missingLedger ? "missing_ledger" : file.rule ?? file.status;
    issues.push({
      path: file.path,
      code,
      message: file.message ?? (file.status === "missing" ? "文件不存在。" : `数据文件检查状态：${file.status}。`),
      auto_fixable: missingLedger && Object.hasOwn(EMPTY_LEDGER_CONTENT, file.path),
    });
  }

  for (const [file, required] of Object.entries(REQUIRED_BLOCKS)) {
    const absolute = path.join(projectPath, paths[file === PATHS.readme ? "readme" : "agentsMd"]);
    let markdown: string;
    try { markdown = await readFile(absolute, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      issues.push({ path: file, code: "document_missing", message: `缺少 ${path.basename(file)}，可从内置工作区模板恢复。`, auto_fixable: true });
      continue;
    }
    try {
      const existing = new Set(parseReadmeAutoBlocks(markdown).map((block) => block.id));
      for (const id of required) if (!existing.has(id)) issues.push(autoBlockIssue(file, id));
    } catch (error) {
      issues.push({ path: file, code: "auto_blocks_invalid", message: error instanceof Error ? error.message : String(error), auto_fixable: false });
    }
  }
  issues.sort((left, right) => compareKeys(left.path, right.path) || compareKeys(left.code, right.code));
  return { issues, config, configSource, ...(manifest ? { manifest } : {}) };
}

async function appendMissingBlocks(filePath: string, markdown: string, required: readonly string[]): Promise<boolean> {
  const existing = new Set(parseReadmeAutoBlocks(markdown).map((block) => block.id));
  const missing = required.filter((id) => !existing.has(id));
  if (!missing.length) return false;
  const blocks = missing.map((id) => `<!-- siteindex:auto:start id="${id}" -->\n<!-- siteindex:auto:end id="${id}" -->`).join("\n\n");
  const separator = markdown.length === 0 ? "" : markdown.endsWith("\n\n") ? "" : markdown.endsWith("\n") ? "\n" : "\n\n";
  await appendFile(filePath, `${separator}${blocks}\n`, "utf8");
  return true;
}

export async function checkWorkspaceImport(
  projectPath: string,
  options: { apply?: boolean; templateDir?: string } = {},
): Promise<WorkspaceImportCheckResult> {
  const project = path.resolve(projectPath);
  const paths = pathsFor("workspace");
  const configPath = path.join(project, paths.site);
  const first = await inspectWorkspace(project);
  if (first.issues.some((issue) => issue.code === "workspace_config_missing" || issue.code === "workspace_config_invalid") || !options.apply) {
    return { issues: first.issues, repaired: [] };
  }

  const template = await loadWorkspaceTemplate(options.templateDir);
  const manifestRelative = path.posix.join(paths.index, "workspace.json");
  const manifest = manifestForConfig(first.manifest ?? template.manifest, validWorkspaceConfig(first.config?.workspace) ? first.config.workspace : undefined);
  const repaired = new Set<string>();
  const codes = new Set(first.issues.filter((issue) => issue.auto_fixable).map((issue) => `${issue.path}\0${issue.code}`));

  if (codes.has(`${manifestRelative}\0workspace_manifest_missing`)) {
    const created = await exclusiveWrite(path.join(project, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`);
    if (created) repaired.add(manifestRelative);
  }

  if (codes.has(`${paths.site}\0workspace_metadata_missing`) && first.config && first.configSource !== undefined) {
    const latestSource = await readFile(configPath, "utf8");
    if (latestSource !== first.configSource) throw new Error("site.json 在导入检查期间发生变化，请重新检查后再修复。");
    const nextConfig = { ...first.config, workspace: metadataFromManifest(first.manifest ?? template.manifest) };
    await atomicWrite(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    repaired.add(paths.site);
  }

  for (const issue of first.issues.filter((item) => item.code === "missing_ledger" && item.auto_fixable)) {
    const contents = EMPTY_LEDGER_CONTENT[issue.path];
    if (contents === undefined) continue;
    const created = await exclusiveWrite(path.join(project, issue.path), contents);
    if (created) repaired.add(issue.path);
  }

  for (const [file, required] of Object.entries(REQUIRED_BLOCKS)) {
    const relative = paths[file === PATHS.readme ? "readme" : "agentsMd"];
    const absolute = path.join(project, relative);
    let source: string;
    try { source = await readFile(absolute, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const templateDoc = template.files.get(file);
      if (!templateDoc || !first.config) continue;
      if (await exclusiveWrite(absolute, emptyTemplateDoc(templateDoc, first.config))) repaired.add(relative);
      continue;
    }
    if (first.issues.some((issue) => issue.path === file && issue.code === "auto_blocks_invalid")) continue;
    if (await appendMissingBlocks(absolute, source, required)) repaired.add(relative);
  }

  const final = await inspectWorkspace(project);
  return {
    issues: final.issues,
    repaired: [...repaired].sort(compareKeys),
  };
}
