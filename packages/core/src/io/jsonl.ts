import { readFile } from "node:fs/promises";
import { atomicWrite } from "./atomic-write";
import { compareKeys } from "./compare";

export type JsonRecord = Record<string, unknown>;
export interface JsonlOptions {
  primaryKey?: readonly string[];
  fieldOrder?: readonly string[];
}

interface JsonSchema {
  properties?: Record<string, unknown>;
  "x-primary-key"?: string[];
}

const schemaCache = new Map<string, Promise<JsonSchema>>();

async function loadSchema(name: string): Promise<JsonSchema> {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`无效 schema 名称: ${name}`);
  let schema = schemaCache.get(name);
  if (!schema) {
    schema = readFile(new URL(`../../../../schemas/${name}.schema.json`, import.meta.url), "utf8")
      .then((text) => JSON.parse(text) as JsonSchema);
    schemaCache.set(name, schema);
  }
  return schema;
}

export async function readJsonl(filePath: string): Promise<JsonRecord[]> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: JsonRecord[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("每行必须是 JSON 对象");
      }
      rows.push(value as JsonRecord);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: JSONL 格式错误: ${(error as Error).message}`, { cause: error });
    }
  }
  return rows;
}

function keyPart(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function compareRows(a: JsonRecord, b: JsonRecord, keys: readonly string[]): number {
  for (const key of keys) {
    const order = compareKeys(keyPart(a[key]), keyPart(b[key]));
    if (order !== 0) return order;
  }
  return 0;
}

function ordered(row: JsonRecord, fields?: readonly string[]): JsonRecord {
  if (!fields?.length) return row;
  const result: JsonRecord = {};
  for (const field of fields) if (Object.hasOwn(row, field)) result[field] = row[field];
  for (const [key, value] of Object.entries(row)) if (!Object.hasOwn(result, key)) result[key] = value;
  return result;
}

/** 缺省字段顺序和主键从 schemas/*.schema.json 读取，与 Python common.py 一致。 */
export async function writeJsonl(
  filePath: string,
  rows: readonly JsonRecord[],
  schemaOrOptions?: string | JsonlOptions,
): Promise<void> {
  let options: JsonlOptions;
  if (typeof schemaOrOptions === "string") {
    const schema = await loadSchema(schemaOrOptions);
    options = {
      fieldOrder: schema.properties ? Object.keys(schema.properties) : undefined,
      primaryKey: schema["x-primary-key"],
    };
  } else {
    options = schemaOrOptions ?? {};
  }
  const sorted = options.primaryKey?.length
    ? [...rows].sort((a, b) => compareRows(a, b, options.primaryKey ?? []))
    : [...rows];
  const output = sorted.map((row) => JSON.stringify(ordered(row, options.fieldOrder))).join("\n");
  await atomicWrite(filePath, output ? `${output}\n` : "");
}
