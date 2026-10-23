import { readFile } from "node:fs/promises";
import path from "node:path";
import { CSV_HEADERS, LEDGER_PATHS, PATHS, type SiteIndexError } from "@siteindex/shared";
import { readCsv, writeCsv } from "./io/csv";
import { readJsonl, type JsonRecord, writeJsonl } from "./io/jsonl";

export type LedgerName = keyof typeof LEDGER_PATHS;
export type LedgerKey = string | readonly string[];

export interface LedgerMutationResult {
  added: number;
  updated: number;
  deleted: number;
  total: number;
}

export interface LedgerMutationOptions {
  /** Test and deterministic callers may supply a clock; otherwise the site timezone is used. */
  now?: Date;
}

interface LedgerSchema {
  properties?: Record<string, unknown>;
  "x-primary-key"?: string[];
}

interface LedgerSpec {
  schema: string;
  format: "csv" | "jsonl";
  headers?: readonly string[];
}

const LEDGER_SPECS: Record<LedgerName, LedgerSpec> = {
  keywords: { schema: "keyword", format: "jsonl" },
  sku_media: { schema: "sku_media", format: "csv", headers: CSV_HEADERS.skuMedia },
  sku_tags: { schema: "sku_tags", format: "csv", headers: CSV_HEADERS.skuTags },
  edm_campaigns: { schema: "edm_campaign", format: "jsonl" },
  outreach: { schema: "outreach_contact", format: "jsonl" },
};

const schemaCache = new Map<string, Promise<LedgerSchema>>();

async function readLedgerSchema(name: string): Promise<LedgerSchema> {
  let schema = schemaCache.get(name);
  if (!schema) {
    schema = readFile(new URL(`../../../schemas/${name}.schema.json`, import.meta.url), "utf8")
      .then((text) => JSON.parse(text) as LedgerSchema);
    schemaCache.set(name, schema);
  }
  return schema;
}

function configError(message: string): Error & SiteIndexError {
  return Object.assign(new Error(message), { code: "CONFIG_INVALID" as const });
}

function keyValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function rowKey(row: JsonRecord, primaryKey: readonly string[]): string {
  return JSON.stringify(primaryKey.map((field) => keyValue(row[field])));
}

function normalizeRow(ledger: LedgerName, input: JsonRecord, fields: readonly string[], today: string): JsonRecord {
  const row = { ...input };
  if (ledger === "keywords" && row.keyword) {
    row.keyword = typeof row.keyword === "string" ? row.keyword.trim().toLowerCase() : row.keyword;
  }
  if (ledger === "outreach" && row.domain) {
    row.domain = typeof row.domain === "string"
      ? row.domain.trim().toLowerCase().replace(/^www\./, "")
      : row.domain;
  }
  if (fields.includes("updated_at") && !Object.hasOwn(row, "updated_at")) row.updated_at = today;
  if (ledger === "outreach" && !Object.hasOwn(row, "added_at")) row.added_at = today;
  return row;
}

async function todayForProject(projectPath: string, now: Date): Promise<string> {
  let timezone: string | undefined;
  let configText: string;
  try {
    configText = await readFile(path.join(projectPath, PATHS.site), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error("项目配置不存在。"), { code: "PROJECT_NOT_FOUND" as const });
    }
    throw Object.assign(new Error("无法读取项目配置。"), { code: "PROJECT_UNREADABLE" as const });
  }
  try {
    const config = JSON.parse(configText) as { timezone?: unknown };
    if (typeof config.timezone === "string") timezone = config.timezone;
  } catch {
    throw configError("项目 site.json 格式无效。");
  }

  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(now);
      const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      return `${values.year}-${values.month}-${values.day}`;
    } catch {
      // Python reference falls back to the local date when the configured timezone is invalid.
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function mutateLedger(
  projectPath: string,
  ledger: LedgerName,
  rows: readonly JsonRecord[],
  deleteKeys: readonly LedgerKey[],
  options: LedgerMutationOptions,
): Promise<LedgerMutationResult> {
  const spec = LEDGER_SPECS[ledger];
  if (!spec) throw configError(`不支持的台账: ${String(ledger)}`);
  const schema = await readLedgerSchema(spec.schema);
  const fields = Object.keys(schema.properties ?? {});
  const primaryKey = schema["x-primary-key"] ?? [];
  if (!primaryKey.length) throw configError(`台账 ${ledger} 缺少主键定义。`);

  const filePath = path.join(projectPath, LEDGER_PATHS[ledger]);
  const current = spec.format === "csv" ? await readCsv(filePath) : await readJsonl(filePath);
  const indexed = new Map<string, JsonRecord>();
  for (const row of current) indexed.set(rowKey(row, primaryKey), row);

  let deleted = 0;
  for (const rawKey of deleteKeys) {
    const parts = typeof rawKey === "string" ? rawKey.split("|") : [...rawKey];
    if (parts.length !== primaryKey.length) {
      throw configError(`台账 ${ledger} 的删除键需要 ${primaryKey.length} 个字段 (${primaryKey.join("+")})。`);
    }
    const key = JSON.stringify(parts);
    if (indexed.delete(key)) deleted += 1;
  }

  const today = await todayForProject(projectPath, options.now ?? new Date());
  let added = 0;
  let updated = 0;
  for (const input of rows) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw configError(`台账 ${ledger} 的每行都必须是 JSON 对象。`);
    }
    const row = normalizeRow(ledger, input, fields, today);
    if (primaryKey.some((field) => row[field] === null || row[field] === undefined || row[field] === "")) {
      throw configError(`台账 ${ledger} 缺少主键 ${primaryKey.join("+")}。`);
    }
    if (spec.format === "csv") {
      for (const [field, value] of Object.entries(row)) if (Array.isArray(value)) row[field] = value.join(";");
    }

    const key = rowKey(row, primaryKey);
    const existing = indexed.get(key);
    if (existing) {
      Object.assign(existing, row);
      updated += 1;
    } else {
      indexed.set(key, row);
      added += 1;
    }
  }

  const output = [...indexed.values()];
  if (spec.format === "csv") {
    await writeCsv(filePath, output, spec.headers ?? [], primaryKey);
  } else {
    await writeJsonl(filePath, output, spec.schema);
  }
  return { added, updated, deleted, total: output.length };
}

/** 插入或部分更新台账记录，并按 schema 主键排序写回。 */
export function upsertLedger(
  projectPath: string,
  ledger: LedgerName,
  rows: readonly JsonRecord[],
  options: LedgerMutationOptions = {},
): Promise<LedgerMutationResult> {
  return mutateLedger(projectPath, ledger, rows, [], options);
}

/** 按 schema 主键删除台账记录；复合主键可用字段数组或以 | 连接的字符串。 */
export function deleteLedger(
  projectPath: string,
  ledger: LedgerName,
  keys: readonly LedgerKey[],
  options: LedgerMutationOptions = {},
): Promise<LedgerMutationResult> {
  return mutateLedger(projectPath, ledger, [], keys, options);
}
