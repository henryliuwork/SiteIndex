#!/usr/bin/env node
/**
 * @siteindex/cli — 工作流 A 负责。
 * 命令表见 docs/ARCHITECTURE.md §6；退出码见 @siteindex/shared EXIT。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  atomicWrite,
  createCoreService,
  deleteLedger,
  renderEdm,
  upsertLedger,
  writeRunner,
  type CoreService,
  type LedgerKey,
  type LedgerName,
} from "@siteindex/core";
import {
  CLI_BIN,
  CLI_COMMANDS,
  EXIT,
  PATHS,
  QUERY_TARGETS,
  WRITABLE_LEDGERS,
  isSiteIndexError,
  type AppSettings,
  type CliJsonOutput,
  type CreateProjectInput,
  type ExitCode,
  type JobName,
  type ListQuery,
  type ProjectId,
  type RepairAction,
  type ScheduleConfig,
  type SkillInfo,
  type ProductFilters,
  type SkuStockFilters,
  type SeoPageFilters,
  type SeoIssueFilters,
  type BlogFilters,
  type KeywordFilters,
  type SkuImageFilters,
} from "@siteindex/shared";

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  stdin?: () => Promise<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  service?: CoreService;
  settings?: Partial<CliRuntimeSettings>;
  skillsDir?: string;
  templateDir?: string;
}

export interface CliRuntimeSettings {
  device_id?: string;
  device_name?: string;
  projects_root?: string;
  extra_projects?: string[];
  cache_dir?: string;
  skill_platforms?: AppSettings["skill_platforms"];
}

type RuntimeSettings = CliRuntimeSettings;

interface ParsedArgs {
  positionals: string[];
  options: Map<string, (string | true)[]>;
  json: boolean;
  help: boolean;
}

interface Outcome {
  exitCode: ExitCode;
  data?: unknown;
  message?: string;
  error?: { code: string; message: string };
}

interface Runtime {
  io: CliIO;
  settings: RuntimeSettings;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  deviceId: string;
  deviceName: string;
  skillsDir: string;
  service: CoreService;
}

class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  constructor(code: string, message: string, exitCode: ExitCode = EXIT.BAD_ARGS) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const BOOLEAN_OPTIONS = new Set(["allow-oos", "force", "json", "repair"]);
const QUERY_CONTROL_OPTIONS = new Set(["page", "size", "search", "sort", "order"]);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, (string | true)[]>();
  let json = false;
  let help = false;
  let positionalOnly = false;
  const addOption = (key: string, value: string | true) => {
    const current = options.get(key) ?? [];
    current.push(value);
    options.set(key, current);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (positionalOnly) { positionals.push(token); continue; }
    if (token === "--") { positionalOnly = true; continue; }
    if (token === "--json") { json = true; continue; }
    if (token === "--help" || token === "-h") { help = true; continue; }
    if (!token.startsWith("--")) { positionals.push(token); continue; }

    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (!key) throw new CliError("BAD_ARGS", "选项名称不能为空。");
    if (equals >= 0) { addOption(key, token.slice(equals + 1)); continue; }
    if (BOOLEAN_OPTIONS.has(key)) { addOption(key, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new CliError("BAD_ARGS", "选项 --" + key + " 需要一个值。");
    addOption(key, value);
    index += 1;
  }
  return { positionals, options, json, help };
}

function option(options: ParsedArgs["options"], name: string): string | undefined {
  const value = options.get(name)?.[0];
  return typeof value === "string" ? value : undefined;
}

function optionEnabled(options: ParsedArgs["options"], name: string): boolean {
  const value = options.get(name)?.[0];
  return value === true || value === "true" || value === "1";
}

function requiredArg(args: readonly string[], index: number, usage: string): string {
  const value = args[index];
  if (!value) throw new CliError("BAD_ARGS", "用法: " + CLI_BIN + " " + usage);
  return value;
}

function parseInteger(value: string | undefined, fallback: number, label: string, minimum = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new CliError("BAD_ARGS", label + " 必须是大于等于 " + minimum + " 的整数。");
  return parsed;
}

function parseFilterValue(value: string | true | undefined): unknown {
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  return value;
}

function queryInput(options: ParsedArgs["options"], positionals: readonly string[]): ListQuery<Record<string, unknown>> {
  const filters: Record<string, unknown> = {};
  for (const [key, values] of options) {
    if (QUERY_CONTROL_OPTIONS.has(key)) continue;
    filters[key.replaceAll("-", "_")] = parseFilterValue(values[0]);
  }
  for (const token of positionals) {
    const separator = token.indexOf("=");
    if (separator > 0) filters[token.slice(0, separator).replaceAll("-", "_")] = parseFilterValue(token.slice(separator + 1));
  }
  const page = parseInteger(option(options, "page"), 1, "--page", 1);
  const pageSize = parseInteger(option(options, "size"), 50, "--size", 0);
  const sortValue = option(options, "sort");
  let sort: ListQuery["sort"];
  if (sortValue) {
    const [field, direction] = sortValue.split(":");
    const dir = direction ?? option(options, "order") ?? "asc";
    if (!field || (dir !== "asc" && dir !== "desc")) throw new CliError("BAD_ARGS", "--sort 用 field[:asc|desc] 格式填写。");
    sort = { field, dir };
  }
  const search = option(options, "search");
  return {
    page, pageSize,
    ...(search !== undefined ? { search } : {}),
    ...(sort ? { sort } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  };
}

function parseCsv(text: string): Record<string, string | null>[] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ",") { cells.push(cell); cell = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      cells.push(cell); rows.push(cells); cells = []; cell = "";
    } else cell += character;
  }
  if (quoted) throw new CliError("BAD_ARGS", "CSV 输入有未闭合的引号。");
  if (cell.length || cells.length) { cells.push(cell); rows.push(cells); }
  if (!rows.length) return [];
  const headers = rows[0]!;
  return rows.slice(1).filter((row) => !(row.length === 1 && row[0] === ""))
    .map((row) => Object.fromEntries(headers.map((header, index) => {
      const value = row[index];
      return [header, value === undefined || value === "" ? null : value];
    })));
}

function parseJsonRows(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = trimmed.startsWith("[")
    ? JSON.parse(trimmed) as unknown
    : trimmed.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new CliError("BAD_ARGS", "JSON 台账输入必须由对象组成。");
  return rows as Record<string, unknown>[];
}

function projectId(value: string): ProjectId { return value as ProjectId; }

function parseSettings(value: unknown): RuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.device_id === "string" ? { device_id: row.device_id } : {}),
    ...(typeof row.device_name === "string" ? { device_name: row.device_name } : {}),
    ...(typeof row.projects_root === "string" ? { projects_root: row.projects_root } : {}),
    ...(Array.isArray(row.extra_projects) ? { extra_projects: row.extra_projects.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof row.cache_dir === "string" ? { cache_dir: row.cache_dir } : {}),
    ...(Array.isArray(row.skill_platforms) ? { skill_platforms: row.skill_platforms as AppSettings["skill_platforms"] } : {}),
  };
}

function userDataDirectory(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "SiteIndex");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "SiteIndex");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "SiteIndex");
}

async function readRuntimeSettings(env: NodeJS.ProcessEnv): Promise<RuntimeSettings> {
  try { return parseSettings(JSON.parse(await readFile(path.join(userDataDirectory(env), "settings.json"), "utf8")) as unknown); }
  catch { return {}; }
}

function resolveProjectPath(value: string, cwd: string, settings: RuntimeSettings): string {
  const localPath = path.resolve(cwd, value);
  const hasPathSyntax = path.isAbsolute(value) || value.startsWith(".") || value.includes("/") || value.includes("\\");
  if (hasPathSyntax || existsSync(localPath)) return localPath;
  const extra = settings.extra_projects?.find((candidate) => path.basename(candidate).toLowerCase() === value.toLowerCase());
  if (extra) return path.resolve(extra);
  return path.resolve(settings.projects_root || path.join(os.homedir(), "SiteIndex", "Projects"), value);
}

async function firstExisting(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; }
    catch { /* Check the next packaged or development resource location. */ }
  }
  return candidates[0] ?? process.cwd();
}

async function createRuntime(io: CliIO, browserExecutablePath?: string): Promise<Runtime> {
  const env = io.env ?? process.env;
  const cwd = path.resolve(io.cwd ?? process.cwd());
  const settings = io.settings ? { ...await readRuntimeSettings(env), ...io.settings } : await readRuntimeSettings(env);
  const userData = userDataDirectory(env);
  const cacheDir = settings.cache_dir || path.join(userData, "cache");
  const deviceId = settings.device_id || createHash("sha256").update(os.hostname() + "\0" + os.homedir()).digest("hex").slice(0, 32);
  const deviceName = settings.device_name || os.hostname();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const skillsDir = io.skillsDir ?? await firstExisting([
    path.join(moduleDir, "skills"), path.resolve(moduleDir, "../../../skills"), path.resolve(cwd, "skills"),
  ]);
  const templateDir = io.templateDir ?? await firstExisting([
    path.join(moduleDir, "templates", "project"), path.resolve(moduleDir, "../../../templates/project"), path.resolve(cwd, "templates/project"),
  ]);
  const service = io.service ?? createCoreService({
    resolveProject: (id) => resolveProjectPath(String(id), cwd, settings),
    deviceId, deviceName, cacheDir, templateDir, browserExecutablePath,
  });
  return { io, settings, cwd, env, cacheDir, deviceId, deviceName, skillsDir, service };
}

function outputHelp(): string {
  return "用法: " + CLI_BIN + " <命令> [参数]\n命令: " + CLI_COMMANDS.filter((command) => command !== "folders").join(", ")
    + "\n运行 design / index-check 时使用 --browser <Chrome/Edge 可执行文件路径>。";
}

function success(data: unknown, message?: string): Outcome {
  return { exitCode: EXIT.OK, data, ...(message ? { message } : {}) };
}

function failure(exitCode: ExitCode, code: string, message: string, data?: unknown): Outcome {
  return { exitCode, error: { code, message }, ...(data !== undefined ? { data } : {}) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isSiteIndexError(error)) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof CliError) return error.code;
  if (isSiteIndexError(error)) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN";
}

function errorExitCode(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode;
  if (error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number") {
    const code = error.exitCode;
    if (Object.values(EXIT).some((value) => value === code)) return code as ExitCode;
  }
  switch (errorCode(error)) {
    case "CONFIG_INVALID": return EXIT.VALIDATION_FAILED;
    case "GUARD_ABORTED": return EXIT.GUARD_ABORTED;
    case "LOCKED": return EXIT.LOCKED;
    case "NOT_RUNNER": return EXIT.NOT_RUNNER;
    case "BROWSER_UNAVAILABLE": return EXIT.BROWSER_UNAVAILABLE;
    case "PATH_OUTSIDE_PROJECT":
    case "FOLDER_PROTECTED":
    case "FOLDER_EXISTS":
    case "BAD_ARGS": return EXIT.BAD_ARGS;
    default: return EXIT.SOURCE_FAILED;
  }
}

function emitOutcome(io: CliIO, json: boolean, outcome: Outcome): void {
  if (json) {
    const payload: CliJsonOutput = {
      ok: outcome.exitCode === EXIT.OK,
      exit_code: outcome.exitCode,
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    io.out(JSON.stringify(payload));
  } else if (outcome.exitCode === EXIT.OK) {
    io.out(outcome.message ?? JSON.stringify(outcome.data, null, 2));
  } else {
    io.err(outcome.error?.message ?? outcome.message ?? "命令执行失败。");
    if (outcome.data !== undefined) io.err(JSON.stringify(outcome.data, null, 2));
  }
}

async function stdinText(io: CliIO): Promise<string> {
  if (io.stdin) return await io.stdin();
  return await new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { input += chunk; });
    process.stdin.once("end", () => resolve(input));
    process.stdin.once("error", reject);
  });
}

async function readRows(runtime: Runtime, ledger: LedgerName, rowsPath: string): Promise<Record<string, unknown>[]> {
  const text = rowsPath === "-" ? await stdinText(runtime.io) : await readFile(path.resolve(runtime.cwd, rowsPath), "utf8");
  return ledger === "sku_media" || ledger === "sku_tags" ? parseCsv(text) : parseJsonRows(text);
}

const LEDGER_KEYS: Record<LedgerName, readonly string[]> = {
  keywords: ["keyword"], sku_media: ["sku", "image_role"], sku_tags: ["sku"],
  edm_campaigns: ["campaign_id"], outreach: ["domain"],
};

function deleteKeys(ledger: LedgerName, raw: readonly string[]): LedgerKey[] {
  const count = LEDGER_KEYS[ledger].length;
  if (count === 1) return [...raw];
  if (raw.every((value) => value.includes("|"))) return [...raw];
  if (raw.length % count !== 0) throw new CliError("BAD_ARGS", "台账 " + ledger + " 的删除键需要字段 " + LEDGER_KEYS[ledger].join("、") + "；复合键可用 | 连接。");
  const keys: LedgerKey[] = [];
  for (let index = 0; index < raw.length; index += count) keys.push(raw.slice(index, index + count));
  return keys;
}

async function query(runtime: Runtime, id: ProjectId, target: string, options: ParsedArgs["options"], extra: readonly string[]): Promise<unknown> {
  if (!(QUERY_TARGETS as readonly string[]).includes(target)) throw new CliError("BAD_ARGS", "不支持的 query 目标: " + target);
  const q = queryInput(options, extra);
  switch (target) {
    case "products": return await runtime.service.products.list(id, q as unknown as ListQuery<ProductFilters>);
    case "sku-stock": return await runtime.service.inventory.listSkus(id, q as unknown as ListQuery<SkuStockFilters>);
    case "seo-pages": return await runtime.service.seo.listPages(id, q as unknown as ListQuery<SeoPageFilters>);
    case "seo-issues": return await runtime.service.seo.listIssues(id, q as unknown as ListQuery<SeoIssueFilters>);
    case "blog": return await runtime.service.content.listBlog(id, q as unknown as ListQuery<BlogFilters>);
    case "keywords": return await runtime.service.content.listKeywords(id, q as unknown as ListQuery<KeywordFilters>);
    case "sku-media": return await runtime.service.edm.listImages(id, q as unknown as ListQuery<SkuImageFilters>);
    default: throw new CliError("BAD_ARGS", "不支持的 query 目标: " + target);
  }
}

async function skillInfo(skillPath: string, fallbackName: string): Promise<SkillInfo> {
  const markdown = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1] ?? "";
  const field = (name: string): string | undefined => new RegExp("^" + name + ":\\s*[\"']?([^\\r\\n\"']+)", "mu").exec(frontMatter)?.[1]?.trim();
  return {
    name: field("name") || fallbackName,
    version: field("version") || "0.0.0",
    description: field("description") || "",
    has_update: false,
    reads: [],
    writes: [],
  };
}

async function listSkills(skillsDir: string): Promise<{ path: string; info: SkillInfo }[]> {
  let entries;
  try { entries = await readdir(skillsDir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const result: { path: string; info: SkillInfo }[] = [];
  for (const name of names) {
    const skillPath = path.join(skillsDir, name);
    try { result.push({ path: skillPath, info: await skillInfo(skillPath, name) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}

async function syncSkills(runtime: Runtime, project: string): Promise<{ skills: string[]; manifest: string }> {
  const projectPath = resolveProjectPath(project, runtime.cwd, runtime.settings);
  const skills = await listSkills(runtime.skillsDir);
  if (!skills.length) throw new CliError("PROJECT_NOT_FOUND", "找不到软件内置 skills 目录。", EXIT.SOURCE_FAILED);
  const targetRoot = path.join(projectPath, PATHS.skillsDir);
  await mkdir(targetRoot, { recursive: true });
  for (const skill of skills) await cp(skill.path, path.join(targetRoot, skill.info.name), { recursive: true, force: true });
  const manifestPath = path.join(projectPath, PATHS.skillsManifest);
  const manifest = { schema_version: "1.0", skills: skills.map(({ info }) => ({ name: info.name, version: info.version })) };
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { skills: skills.map(({ info }) => info.name), manifest: manifestPath };
}

function skillTarget(platform: string, runtime: Runtime): string {
  const configured = runtime.settings.skill_platforms?.find((item) => item.id === platform);
  if (configured?.dir) return configured.dir;
  if (platform === "claude-code") return path.join(os.homedir(), ".claude", "skills");
  if (platform === "codex") return path.join(os.homedir(), ".codex", "skills");
  throw new CliError("BAD_ARGS", "未知 platform: " + platform + "；请先在 SiteIndex 设置中配置该 skill 目录。");
}

async function execute(runtime: Runtime, parsed: ParsedArgs): Promise<Outcome> {
  const args = parsed.positionals;
  const command = requiredArg(args, 0, "<命令>");
  const rest = args.slice(1);

  if (command === "detect") {
    return success(await runtime.service.projects.detect(requiredArg(rest, 0, "detect <url>")));
  }

  if (command === "init") {
    const dir = requiredArg(rest, 0, "init <dir> --url <url> --feed <url>");
    const url = option(parsed.options, "url");
    const feed = option(parsed.options, "feed");
    if (!url || !feed) throw new CliError("BAD_ARGS", "init 必须提供 --url 和 --feed。");
    const simpleName = !path.isAbsolute(dir) && !dir.includes("/") && !dir.includes("\\") && dir !== "." && dir !== "..";
    const targetPath = path.resolve(runtime.cwd, dir);
    const folderName = path.basename(targetPath);
    const missingAs = option(parsed.options, "missing-as") || "out_of_stock";
    if (missingAs !== "out_of_stock" && missingAs !== "removed") throw new CliError("BAD_ARGS", "--missing-as 只能是 out_of_stock 或 removed。");
    const input: CreateProjectInput = {
      url, feed_urls: feed.split(",").map((item) => item.trim()).filter(Boolean),
      sku_field: option(parsed.options, "sku-field") || "id",
      category_depth: parseInteger(option(parsed.options, "category-depth"), 1, "--category-depth", 1),
      missing_as: missingAs,
      brand: { name: option(parsed.options, "name") || folderName },
      markets: [],
      projects_root: simpleName ? runtime.settings.projects_root || runtime.cwd : path.dirname(targetPath),
      folder_name: folderName,
      workspace_folders: [], // shared 的旧字段仍必填，core 不再使用。
    };
    if (option(parsed.options, "folders") !== undefined) throw new CliError("BAD_ARGS", "--folders 已停用，请自行管理工作文件夹。");
    return success(await runtime.service.projects.create(input), "项目已创建。");
  }

  if (command === "feed") {
    if (requiredArg(rest, 0, "feed inspect <p>") !== "inspect") throw new CliError("BAD_ARGS", "用法: siteindex feed inspect <p>");
    const detail = await runtime.service.projects.get(projectId(requiredArg(rest, 1, "feed inspect <p>")));
    const feedUrls = Array.isArray(detail.config.crawl.feed_url) ? detail.config.crawl.feed_url : [detail.config.crawl.feed_url];
    return success(await runtime.service.projects.inspectFeed(feedUrls, {
      sku_field: detail.config.crawl.sku_field || "id",
      category_depth: detail.config.crawl.category_depth || 1,
    }));
  }

  if (command === "run" || command === "views") {
    const project = requiredArg(rest, 0, command + " <p>");
    const job = command === "views" ? "views" : requiredArg(rest, 1, "run <p> <daily|weekly|monthly|validate|readme|design|index-check>");
    const allowed = ["daily", "weekly", "monthly", "validate", "readme", "design", "index-check"];
    if (command === "run" && !allowed.includes(job)) throw new CliError("BAD_ARGS", "不支持的 Job: " + job);
    const result = await runtime.service.runJob({
      projectPath: resolveProjectPath(project, runtime.cwd, runtime.settings),
      job: job as JobName,
      trigger: "cli",
      ...(option(parsed.options, "date") ? { date: option(parsed.options, "date") } : {}),
      ...(option(parsed.options, "only") ? { only: option(parsed.options, "only") } : {}),
      ...(optionEnabled(parsed.options, "force") ? { force: true } : {}),
    }, (progress) => {
      const pct = progress.pct === null ? "" : " " + progress.pct + "%";
      runtime.io.err(progress.message + pct);
    });
    if (result.exitCode !== EXIT.OK) return failure(asExitCode(result.exitCode), "JOB_FAILED", result.summary + (result.errors?.length ? "\n" + result.errors.join("\n") : ""), result);
    return success(result, result.summary);
  }

  if (command === "validate") {
    const id = projectId(requiredArg(rest, 0, "validate <p> [--repair] [--file <path>]"));
    const file = option(parsed.options, "file");
    let report = await runtime.service.files.validate(id, file);
    const repaired: string[] = [];
    if (optionEnabled(parsed.options, "repair")) {
      for (const check of report.files) {
        if (check.status === "ok" || !check.repair) continue;
        const fixed = await runtime.service.files.repair(id, check.path, check.repair as RepairAction);
        repaired.push(fixed.path);
      }
      report = await runtime.service.files.validate(id, file);
    }
    const hasErrors = report.summary.error > 0 || report.summary.missing > 0 || report.summary.conflict_copy > 0;
    const data = { report, repaired };
    return hasErrors
      ? failure(EXIT.VALIDATION_FAILED, "VALIDATION_FAILED", "项目校验发现错误。", data)
      : success(data, optionEnabled(parsed.options, "repair") ? "校验完成，已执行可用修复。" : "项目校验通过。");
  }

  if (command === "query") {
    const project = requiredArg(rest, 0, "query <p> <target>");
    const target = requiredArg(rest, 1, "query <p> <target>");
    return success(await query(runtime, projectId(project), target, parsed.options, rest.slice(2)));
  }

  if (command === "ledger") {
    const operation = requiredArg(rest, 0, "ledger upsert|delete <p> <ledger> …");
    const project = requiredArg(rest, 1, "ledger " + operation + " <p> <ledger> …");
    const ledgerValue = requiredArg(rest, 2, "ledger " + operation + " <p> <ledger> …");
    if (!(WRITABLE_LEDGERS as readonly string[]).includes(ledgerValue)) throw new CliError("BAD_ARGS", "不支持的台账: " + ledgerValue);
    const ledger = ledgerValue as LedgerName;
    const projectPath = resolveProjectPath(project, runtime.cwd, runtime.settings);
    if (operation === "upsert") {
      const rowsPath = option(parsed.options, "rows");
      if (!rowsPath) throw new CliError("BAD_ARGS", "ledger upsert 必须提供 --rows <file|->。");
      const result = await upsertLedger(projectPath, ledger, await readRows(runtime, ledger, rowsPath));
      return success(result, "台账已更新: " + result.added + " 新增，" + result.updated + " 更新。");
    }
    if (operation === "delete") {
      const keys = deleteKeys(ledger, rest.slice(3));
      if (!keys.length) throw new CliError("BAD_ARGS", "ledger delete 至少需要一个主键。");
      const result = await deleteLedger(projectPath, ledger, keys);
      return success(result, "台账已删除 " + result.deleted + " 条记录。");
    }
    throw new CliError("BAD_ARGS", "ledger 只支持 upsert 或 delete。");
  }

  if (command === "edm") {
    if (requiredArg(rest, 0, "edm render <p> <campaignDir> [--allow-oos]") !== "render") throw new CliError("BAD_ARGS", "用法: siteindex edm render <p> <campaignDir> [--allow-oos]");
    const project = requiredArg(rest, 1, "edm render <p> <campaignDir>");
    const campaignDir = requiredArg(rest, 2, "edm render <p> <campaignDir>");
    const result = await renderEdm(resolveProjectPath(project, runtime.cwd, runtime.settings), campaignDir, { allowOos: optionEnabled(parsed.options, "allow-oos") });
    const warnings = result.warnings.length ? "\n" + result.warnings.join("\n") : "";
    return success(result, "EDM 已渲染，包含 " + result.included + " 个产品。" + warnings);
  }

  if (command === "categories") {
    const operation = requiredArg(rest, 0, "categories preview|apply <p>");
    const id = projectId(requiredArg(rest, 1, "categories " + operation + " <p>"));
    const config = await runtime.service.categories.get(id);
    if (operation === "preview") return success(await runtime.service.categories.preview(id, config));
    if (operation === "apply") return success(await runtime.service.categories.save(id, config), "分类已重新计算。");
    throw new CliError("BAD_ARGS", "categories 只支持 preview 或 apply。");
  }

  if (command === "schedule") {
    const operation = requiredArg(rest, 0, "schedule install|remove|list <p>");
    const id = projectId(requiredArg(rest, 1, "schedule " + operation + " <p>"));
    if (operation === "list") return success(await runtime.service.schedule.get(id));
    const current = await runtime.service.schedule.get(id);
    let config: ScheduleConfig = current.config;
    if (operation === "remove") {
      config = {
        ...current.config,
        daily: { ...current.config.daily, enabled: false },
        validate: { ...current.config.validate, enabled: false },
        weekly: { ...current.config.weekly, enabled: false },
        readme: { ...current.config.readme, enabled: false },
        monthly: { ...current.config.monthly, enabled: false },
      };
    } else if (operation !== "install") throw new CliError("BAD_ARGS", "schedule 只支持 install、remove 或 list。");
    const saved = await runtime.service.schedule.save(id, config);
    const guidance = "请打开 SiteIndex 软件后自动注册到系统计划任务。";
    return success({ ...saved, guidance }, operation === "install" ? "计划配置已保存。" + guidance : "计划已停用。请打开 SiteIndex 软件后自动移除系统计划任务。");
  }

  if (command === "runner") {
    const operation = requiredArg(rest, 0, "runner show|claim <p>");
    const project = requiredArg(rest, 1, "runner " + operation + " <p>");
    const id = projectId(project);
    if (operation === "show") return success(await runtime.service.runner.get(id));
    if (operation === "claim") {
      const projectPath = resolveProjectPath(project, runtime.cwd, runtime.settings);
      await writeRunner(projectPath, { device_id: runtime.deviceId, device_name: runtime.deviceName, claimed_at: new Date().toISOString() });
      runtime.service.invalidate(projectPath);
      return success(await runtime.service.runner.get(id), "当前设备已认领为执行设备。");
    }
    throw new CliError("BAD_ARGS", "runner 只支持 show 或 claim。");
  }

  if (command === "skills") {
    const operation = requiredArg(rest, 0, "skills list|sync <p>|install <name> --platform <id>");
    const skills = await listSkills(runtime.skillsDir);
    if (operation === "list") return success(skills.map(({ info }) => info));
    if (operation === "sync") return success(await syncSkills(runtime, requiredArg(rest, 1, "skills sync <p>")), "项目 skills 已同步。");
    if (operation === "install") {
      const name = requiredArg(rest, 1, "skills install <name> --platform <id>");
      const platform = option(parsed.options, "platform");
      if (!platform) throw new CliError("BAD_ARGS", "skills install 必须提供 --platform <id>。");
      const skill = skills.find((item) => item.info.name === name);
      if (!skill) throw new CliError("PROJECT_NOT_FOUND", "找不到内置 skill: " + name, EXIT.SOURCE_FAILED);
      const target = path.join(skillTarget(platform, runtime), skill.info.name);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(skill.path, target, { recursive: true, force: true });
      return success({ name: skill.info.name, platform, path: target }, "Skill 已安装到 " + target);
    }
    throw new CliError("BAD_ARGS", "skills 只支持 list、sync 或 install。");
  }

  throw new CliError("BAD_ARGS", "未知命令: " + command);
}

function asExitCode(value: number): ExitCode {
  return Object.values(EXIT).some((code) => code === value) ? value as ExitCode : EXIT.SOURCE_FAILED;
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  let json = argv.includes("--json");
  try {
    const parsed = parseArgs(argv);
    json = parsed.json;
    if (parsed.help || !parsed.positionals.length) {
      const help = outputHelp();
      emitOutcome(io, json, success(help, help));
      return EXIT.OK;
    }
    const runtime = await createRuntime(io, option(parsed.options, "browser"));
    const outcome = await execute(runtime, parsed);
    emitOutcome(io, json, outcome);
    return outcome.exitCode;
  } catch (error) {
    const outcome: Outcome = failure(errorExitCode(error), errorCode(error), errorMessage(error));
    emitOutcome(io, json, outcome);
    return outcome.exitCode;
  }
}

function runtimeIO(): CliIO {
  return {
    out: (text) => { process.stdout.write(text + "\n"); },
    err: (text) => { process.stderr.write(text + "\n"); },
  };
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
  void main(process.argv.slice(2), runtimeIO()).then((exitCode) => { process.exitCode = exitCode; }).catch((error: unknown) => {
    process.stderr.write(errorMessage(error) + "\n");
    process.exitCode = EXIT.SOURCE_FAILED;
  });
}
