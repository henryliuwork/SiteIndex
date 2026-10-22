import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Ajv2020, { type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CSV_HEADERS, PATHS, type FileCheck, type FileKind, type JobName, type RepairAction, type SiteConfig, type ValidationReport } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";
import { readCsv, writeCsv } from "../io/csv";
import { readJsonl, writeJsonl } from "../io/jsonl";
import { findConflictCopies, isConflictCopy } from "../io/runner-lock";

type Format = "json" | "jsonl" | "csv" | "text";
interface FileSpec {
  path: string;
  kind: FileKind;
  format: Format;
  schema?: string;
  arraySchema?: string;
  headers?: readonly string[];
  key?: readonly string[];
  repair?: RepairAction | null;
}
export interface ValidateOptions {
  trigger?: ValidationReport["trigger"];
  selectedPath?: string;
  now?: Date;
}
export interface RepairOptions {
  runJob: (job: JobName, only?: string) => Promise<{ status: string; summary: string; errors?: string[] }>;
}

const SPECS: FileSpec[] = [
  { path: PATHS.readme, kind: "doc", format: "text", repair: "regenerate:readme" },
  { path: PATHS.agentsMd, kind: "doc", format: "text" },
  { path: PATHS.claudeMd, kind: "doc", format: "text" },
  { path: PATHS.site, kind: "config", format: "json", schema: "site", repair: "autofix" },
  { path: PATHS.skus, kind: "sync", format: "jsonl", schema: "sku", key: ["sku"], repair: "regenerate:daily" },
  { path: PATHS.productDetails, kind: "sync", format: "jsonl", schema: "product_details", repair: "regenerate:weekly.product_details" },
  { path: PATHS.categories, kind: "sync", format: "json", arraySchema: "category", key: ["slug"], repair: "regenerate:weekly.categories" },
  { path: PATHS.inventoryLatest, kind: "sync", format: "jsonl", schema: "inventory_latest", key: ["sku"], repair: "regenerate:daily" },
  { path: PATHS.dailySummary, kind: "sync", format: "csv", headers: CSV_HEADERS.dailySummary, key: ["date", "category"], repair: "regenerate:daily" },
  { path: PATHS.seoPages, kind: "sync", format: "jsonl", schema: "seo_page", repair: "regenerate:weekly.pages" },
  { path: PATHS.seoIssues, kind: "sync", format: "jsonl", schema: "seo_issue", repair: "regenerate:weekly.issues" },
  { path: PATHS.seoLinks, kind: "sync", format: "jsonl", schema: "seo_link", repair: "regenerate:weekly.links" },
  { path: PATHS.blogIndex, kind: "sync", format: "jsonl", schema: "blog_post", repair: "regenerate:weekly.blog" },
  { path: PATHS.keywords, kind: "ledger", format: "jsonl", schema: "keyword", repair: "autofix" },
  { path: PATHS.skuMedia, kind: "ledger", format: "csv", schema: "sku_media", headers: CSV_HEADERS.skuMedia, key: ["sku", "image_role"], repair: "autofix" },
  { path: PATHS.skuTags, kind: "ledger", format: "csv", schema: "sku_tags", headers: CSV_HEADERS.skuTags, key: ["sku"], repair: "autofix" },
  { path: PATHS.edmCampaigns, kind: "ledger", format: "jsonl", schema: "edm_campaign", repair: "autofix" },
  { path: PATHS.outreach, kind: "ledger", format: "jsonl", schema: "outreach_contact", repair: "autofix" },
  { path: PATHS.productsView, kind: "view", format: "jsonl", key: ["handle"], repair: "regenerate:views" },
  { path: PATHS.skuStockView, kind: "view", format: "jsonl", schema: "sku_stock", repair: "regenerate:views" },
  { path: PATHS.runs, kind: "sync", format: "jsonl", schema: "run_log", repair: "autofix" },
];
const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, validateFormats: true });
addFormats(ajv);
const schemaCache = new Map<string, Promise<{ schema: AnySchema; validate: ReturnType<typeof ajv.compile> }>>();
async function getSchema(name: string) {
  let pending = schemaCache.get(name);
  if (!pending) {
    pending = readFile(new URL("../../../../schemas/" + name + ".schema.json", import.meta.url), "utf8")
      .then((source) => {
        const schema = JSON.parse(source) as AnySchema;
        return { schema, validate: ajv.compile(schema) };
      });
    schemaCache.set(name, pending);
  }
  return pending;
}
function errorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).slice(0, 5).map((error) => {
    const place = error.instancePath || "/";
    return place + " " + (error.message ?? "schema validation failed");
  }).join("; ");
}
function localTimestamp(timezone: string, date = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName ?? "GMT+00:00").replace(/^GMT/, "");
  return parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute + ":" + parts.second + offset;
}
function insideProject(projectPath: string, value: string): { absolute: string; relative: string } {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) throw new Error("路径必须是项目内相对路径：" + value);
  const absolute = path.resolve(projectPath, normalized);
  const relative = path.relative(projectPath, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("路径必须位于项目目录内：" + value);
  return { absolute, relative: relative.replaceAll("\\", "/") };
}
function keyFor(row: Record<string, unknown>, keys: readonly string[]): string {
  return JSON.stringify(keys.map((key) => row[key] ?? null));
}
function rowSortCompare(a: Record<string, unknown>, b: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const left = a[key] === null || a[key] === undefined ? "" : String(a[key]);
    const right = b[key] === null || b[key] === undefined ? "" : String(b[key]);
    const order = compareKeys(left, right);
    if (order) return order;
  }
  return 0;
}
function firstRule(checks: FileCheck[], pathName: string, rule: FileCheck["rule"], message: string): void {
  checks.push({ path: pathName, kind: SPECS.find((spec) => spec.path === pathName)?.kind ?? "sync", status: "error", rule, message, repair: SPECS.find((spec) => spec.path === pathName)?.repair ?? null });
}
function repairFor(spec: FileSpec, rule: FileCheck["rule"]): RepairAction | null {
  if (spec.kind === "ledger" && (rule === "parse" || rule === "schema" || rule === "header" || rule === "missing")) return "restore_archive";
  if (rule === "pk_duplicate" || rule === "sort") return "autofix";
  return spec.repair ?? null;
}
async function validateRows(schemaName: string, rows: Record<string, unknown>[]): Promise<string | null> {
  const schema = await getSchema(schemaName);
  for (let index = 0; index < rows.length; index += 1) {
    if (!schema.validate(rows[index])) return "第 " + (index + 1) + " 行 " + errorText(schema.validate.errors);
  }
  return null;
}
async function checkData(spec: FileSpec, absolute: string): Promise<{ rows: Record<string, unknown>[]; count: number; schemaError?: string; headerError?: string; line?: number }> {
  if (spec.format === "text") return { rows: [], count: 1 };
  if (spec.format === "json") {
    const value: unknown = JSON.parse(await readFile(absolute, "utf8"));
    if (spec.arraySchema) {
      if (!Array.isArray(value)) throw new Error("应为 JSON 数组");
      const rows = value as Record<string, unknown>[];
      const schemaError = await validateRows(spec.arraySchema, rows);
      return { rows, count: rows.length, ...(schemaError ? { schemaError } : {}) };
    }
    const rows = value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    const schemaError = spec.schema ? await validateRows(spec.schema, rows) : null;
    return { rows, count: rows.length, ...(schemaError ? { schemaError } : {}) };
  }
  if (spec.format === "csv") {
    const source = await readFile(absolute, "utf8");
    const header = source.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
    const expected = spec.headers?.join(",") ?? "";
    if (header !== expected) return { rows: [], count: 0, headerError: "CSV 表头应为 " + expected };
    const rows = await readCsv(absolute) as Record<string, unknown>[];
    const schemaError = spec.schema ? await validateRows(spec.schema, rows) : null;
    return { rows, count: rows.length, ...(schemaError ? { schemaError } : {}) };
  }
  let rows: Record<string, unknown>[];
  try { rows = await readJsonl(absolute); }
  catch (error) {
    const match = String(error).match(/:(\d+): JSONL/);
    const parseError = new Error(error instanceof Error ? error.message : String(error));
    if (match) Object.assign(parseError, { line: Number(match[1]) });
    throw parseError;
  }
  const schemaError = spec.schema ? await validateRows(spec.schema, rows) : null;
  return { rows, count: rows.length, ...(schemaError ? { schemaError } : {}) };
}

export async function validateProjectFiles(projectPath: string, options: ValidateOptions = {}): Promise<ValidationReport> {
  const project = path.resolve(projectPath);
  const siteFile = path.join(project, PATHS.site);
  let timezone = "UTC";
  try {
    const config = JSON.parse(await readFile(siteFile, "utf8")) as Partial<SiteConfig>;
    if (typeof config.timezone === "string") timezone = config.timezone;
  } catch { /* the site file check below records a missing or malformed configuration */ }
  const selected = options.selectedPath ? insideProject(project, options.selectedPath).relative : "";
  const specs = SPECS.filter((spec) => !selected || spec.path === selected || spec.path.startsWith(selected + "/"));
  if (!selected || selected === PATHS.eventsDir || selected.startsWith(PATHS.eventsDir + "/")) {
    const eventDirectory = path.join(project, PATHS.eventsDir);
    const eventFiles = await readdir(eventDirectory).catch(() => []);
    for (const name of eventFiles.filter((item) => /^\d{4}-\d{2}\.jsonl$/.test(item))) {
      const relative = PATHS.eventsDir + "/" + name;
      if (!selected || relative === selected || relative.startsWith(selected + "/")) {
        specs.push({ path: relative, kind: "sync", format: "jsonl", schema: "inventory_event", key: ["date", "sku", "type"], repair: "regenerate:daily" });
      }
    }
  }
  const checks: FileCheck[] = [];
  const validRows = new Map<string, Record<string, unknown>[]>();
  for (const spec of specs) {
    const absolute = path.join(project, spec.path);
    try {
      const info = await stat(absolute);
      try {
        const data = await checkData(spec, absolute);
        if (data.headerError) {
          checks.push({ path: spec.path, kind: spec.kind, status: "error", rule: "header", message: data.headerError, records: data.count, size: info.size, modified_at: info.mtime.toISOString(), repair: repairFor(spec, "header") });
          continue;
        }
        if (spec.path.startsWith(PATHS.eventsDir + "/")) {
          const month = path.posix.basename(spec.path, ".jsonl");
          if (data.rows.some((row) => typeof row.date !== "string" || !row.date.startsWith(month))) {
            checks.push({ path: spec.path, kind: spec.kind, status: "error", rule: "schema", message: "事件日期必须属于文件月份 " + month,
              records: data.count, size: info.size, modified_at: info.mtime.toISOString(), repair: repairFor(spec, "schema") });
            continue;
          }
        }
        validRows.set(spec.path, data.rows);
        const violations: FileCheck[] = [];
        if (data.schemaError) violations.push({ path: spec.path, kind: spec.kind, status: "error", rule: "schema", message: data.schemaError, records: data.count, size: info.size, modified_at: info.mtime.toISOString(), repair: repairFor(spec, "schema") });
        const schema = spec.schema ? (await getSchema(spec.schema)).schema as Record<string, unknown> : null;
        const keys = spec.key ?? (Array.isArray(schema?.["x-primary-key"]) ? schema["x-primary-key"] as string[] : []);
        const duplicates = new Set<string>();
        const seen = new Set<string>();
        for (const row of data.rows) {
          if (!keys.length) break;
          const key = keyFor(row, keys);
          if (seen.has(key)) duplicates.add(key);
          seen.add(key);
        }
        if (duplicates.size) {
          violations.push({ path: spec.path, kind: spec.kind, status: "error", rule: "pk_duplicate", message: "主键重复 " + duplicates.size + " 个", records: data.count, size: info.size, modified_at: info.mtime.toISOString(), repair: repairFor(spec, "pk_duplicate") });
        }
        if (keys.length && data.rows.some((row, index) => index > 0 && rowSortCompare(data.rows[index - 1]!, row, keys) > 0)) {
          violations.push({ path: spec.path, kind: spec.kind, status: "error", rule: "sort", message: "未按主键 " + keys.join(", ") + " 排序", records: data.count, size: info.size, modified_at: info.mtime.toISOString(), repair: repairFor(spec, "sort") });
        }
        if (violations.length) {
          checks.push(...violations);
          continue;
        }
        const copies = await findConflictCopies(path.dirname(absolute));
        const conflict = copies.find((copy) => path.basename(copy).toLowerCase().startsWith(path.basename(absolute).toLowerCase()));
        checks.push({ path: spec.path, kind: spec.kind, status: conflict ? "conflict_copy" : "ok",
          ...(conflict ? { rule: "conflict_copy", message: "发现冲突副本：" + path.basename(conflict) } : {}),
          records: data.count, size: info.size, modified_at: info.mtime.toISOString(), repair: conflict ? "delete_copy" : spec.repair ?? null });
      } catch (error) {
        const line = typeof error === "object" && error !== null && "line" in error ? Number(error.line) : undefined;
        checks.push({ path: spec.path, kind: spec.kind, status: "error", rule: "parse", message: error instanceof Error ? error.message : String(error),
          ...(line ? { line } : {}), records: null, size: info.size, modified_at: info.mtime.toISOString(), repair: repairFor(spec, "parse") });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") checks.push({ path: spec.path, kind: spec.kind, status: "missing", rule: "missing", message: "文件不存在。", repair: repairFor(spec, "missing") });
      else checks.push({ path: spec.path, kind: spec.kind, status: "error", rule: "parse", message: error instanceof Error ? error.message : String(error), repair: repairFor(spec, "parse") });
    }
  }
  const skuPath = PATHS.skus;
  const skuRows = validRows.get(skuPath) ?? [];
  const skus = new Set(skuRows.map((row) => String(row.sku ?? "")));
  for (const relative of [PATHS.inventoryLatest, PATHS.skuMedia, PATHS.skuTags]) {
    const bad = (validRows.get(relative) ?? []).filter((row) => row.sku && !skus.has(String(row.sku)));
    if (bad.length) firstRule(checks, relative, "ref", bad.length + " 个 SKU 不存在，例如 " + String(bad[0]!.sku));
  }
  const keywords = validRows.get(PATHS.keywords) ?? [];
  const primaryTargets = new Map<string, number>();
  for (const row of keywords) if (row.role === "primary" && typeof row.target_url === "string" && row.target_url) {
    primaryTargets.set(row.target_url, (primaryTargets.get(row.target_url) ?? 0) + 1);
  }
  const duplicateTargets = [...primaryTargets].filter(([, count]) => count > 1);
  if (duplicateTargets.length) firstRule(checks, PATHS.keywords, "schema", "同一目标 URL 有多个 primary 关键词，例如 " + duplicateTargets[0]![0]);
  const readme = checks.find((check) => check.path === PATHS.readme);
  if (readme?.status === "ok") {
    const contents = await readFile(path.join(project, PATHS.readme), "utf8");
    const starts = (contents.match(/<!-- siteindex:auto:start id="[^"]+" -->/g) ?? []).length;
    const ends = (contents.match(/<!-- siteindex:auto:end id="[^"]+" -->/g) ?? []).length;
    if (starts !== ends) firstRule(checks, PATHS.readme, "readme_markers", "README 自动区块标记未成对。");
  }
  const runs = validRows.get(PATHS.runs) ?? [];
  const successfulDaily = runs.filter((row) => row.job === "daily" && row.status === "ok")
    .map((row) => Date.parse(String(row.finished_at ?? row.started_at ?? ""))).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (successfulDaily !== undefined && (options.now ?? new Date()).getTime() - successfulDaily > 36 * 60 * 60 * 1000) {
    firstRule(checks, PATHS.runs, "stale", "最近一次成功 daily 超过 36 小时。");
  }
  const report: ValidationReport = {
    checked_at: localTimestamp(timezone, options.now),
    trigger: options.trigger ?? "manual",
    summary: {
      total: checks.length,
      ok: checks.filter((check) => check.status === "ok").length,
      error: checks.filter((check) => check.status === "error").length,
      missing: checks.filter((check) => check.status === "missing").length,
      conflict_copy: checks.filter((check) => check.status === "conflict_copy").length,
    },
    files: checks,
  };
  await atomicWrite(path.join(project, PATHS.validation), JSON.stringify(report, null, 2) + "\n");
  return report;
}

function repairSchema(pathName: string): { schema?: string; headers?: readonly string[]; key?: readonly string[] } {
  const spec = SPECS.find((item) => item.path === pathName);
  if (!spec) return {};
  if (spec.path === PATHS.categories) return { key: ["slug"] };
  const schema = spec.schema;
  const schemaKey = spec.key ?? (schema ? undefined : undefined);
  return { ...(schema ? { schema } : {}), ...(spec.headers ? { headers: spec.headers } : {}), ...(schemaKey ? { key: schemaKey } : {}) };
}
function stableKey(row: Record<string, unknown>, keys: readonly string[]): string { return keys.map((key) => String(row[key] ?? "")).join("\u0000"); }
async function autofix(projectPath: string, relative: string, absolute: string): Promise<void> {
  const spec = SPECS.find((item) => item.path === relative);
  if (!spec) throw new Error("此文件暂不支持自动整理：" + relative);
  const settings = repairSchema(relative);
  if (spec.format === "jsonl") {
    const rows = await readJsonl(absolute);
    let keys = settings.key;
    if (!keys && settings.schema) {
      const schema = (await getSchema(settings.schema)).schema as Record<string, unknown>;
      keys = Array.isArray(schema["x-primary-key"]) ? schema["x-primary-key"] as string[] : [];
    }
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of rows) unique.set(stableKey(row, keys ?? []), row);
    await writeJsonl(absolute, [...unique.values()], settings.schema ?? { primaryKey: keys ?? [] });
    return;
  }
  if (spec.format === "csv") {
    const rows = await readCsv(absolute);
    const headers = settings.headers ?? spec.headers;
    if (!headers) throw new Error("缺少 CSV 表头规范：" + relative);
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of rows) unique.set(stableKey(row, settings.key ?? spec.key ?? []), row);
    await writeCsv(absolute, [...unique.values()], headers, settings.key ?? spec.key ?? []);
    return;
  }
  if (spec.format === "json" && spec.arraySchema) {
    const rows = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>[];
    const unique = new Map(rows.map((row) => [stableKey(row, ["slug"]), row]));
    const sorted = [...unique.values()].sort((a, b) => compareKeys(String(a.slug ?? ""), String(b.slug ?? "")));
    await atomicWrite(absolute, JSON.stringify(sorted, null, 2) + "\n");
    return;
  }
  if (spec.format === "json") {
    const value = JSON.parse(await readFile(absolute, "utf8"));
    await atomicWrite(absolute, JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const contents = await readFile(absolute, "utf8");
  await atomicWrite(absolute, contents.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n"));
}
async function restoreArchive(projectPath: string, relative: string, absolute: string): Promise<void> {
  const archiveRoot = path.join(projectPath, PATHS.archiveDir);
  const months = await readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  const candidates: { month: string; file: string }[] = [];
  for (const month of months.filter((item) => item.isDirectory()).map((item) => item.name).sort().reverse()) {
    const dir = path.join(archiveRoot, month);
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gz")) {
          const stored = path.relative(dir, file).replaceAll("\\", "/").replace(/\.gz$/i, "");
          if (stored === relative || stored.endsWith("/" + relative)) candidates.push({ month, file });
        }
      }
    };
    await visit(dir);
    if (candidates.length) break;
  }
  const candidate = candidates.sort((a, b) => b.month.localeCompare(a.month))[0];
  if (!candidate) throw new Error("没有找到 " + relative + " 的月度归档。");
  await mkdir(path.dirname(absolute), { recursive: true });
  await atomicWrite(absolute, gunzipSync(await readFile(candidate.file)));
}

export async function repairProjectFile(projectPath: string, relativePath: string, action: RepairAction, options: RepairOptions): Promise<void> {
  const project = path.resolve(projectPath);
  const target = insideProject(project, relativePath);
  if (action === "delete_copy") {
    if (!isConflictCopy(path.basename(target.absolute))) throw new Error("指定文件不是已识别的冲突副本：" + relativePath);
    const archive = path.join(project, PATHS.archiveDir, "quarantine", new Date().toISOString().slice(0, 10), path.basename(target.absolute) + "." + randomUUID());
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(target.absolute, archive);
    return;
  }
  if (action === "autofix") { await autofix(project, target.relative, target.absolute); return; }
  if (action === "restore_archive") { await restoreArchive(project, target.relative, target.absolute); return; }
  if (action.startsWith("regenerate:")) {
    const task = action.slice("regenerate:".length);
    const parts = task.split(".", 2);
    const job = parts[0] as JobName;
    const only = parts[1];
    const result = await options.runJob(job, only);
    if (result.status === "failed") throw new Error(result.summary + (result.errors?.length ? "\n" + result.errors.join("\n") : ""));
    return;
  }
  throw new Error("不支持的修复操作：" + action);
}
