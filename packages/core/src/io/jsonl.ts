import { readFile } from "node:fs/promises";
import { atomicWrite } from "./atomic-write";
import { compareKeys } from "./compare";

export type JsonRecord = Record<string, unknown>;
export interface JsonlOptions {
  primaryKey?: readonly string[];
  fieldOrder?: readonly string[];
  floatFields?: readonly string[];
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

function stringifyRow(row: JsonRecord, floatFields: ReadonlySet<string>): string {
  const serialize = (value: unknown, key?: string): string => {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      const jsonNumber = JSON.stringify(value);
      return key && floatFields.has(key) && Number.isInteger(value) ? `${jsonNumber}.0` : jsonNumber;
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) return `[${value.map((child) => serialize(child)).join(",")}]`;
    if (typeof value === "object") {
      const pairs = Object.entries(value).filter(([, child]) => child !== undefined)
        .map(([childKey, child]) => `${JSON.stringify(childKey)}:${serialize(child, childKey)}`);
      return `{${pairs.join(",")}}`;
    }
    return "null";
  };
  return serialize(ordered(row, undefined));
}

/** 缺省字段顺序和主键从 schemas/*.schema.json 读取，与 Python common.py 一致。 */
export async function writeJsonl(
  filePath: string,
  rows: readonly JsonRecord[],
  schemaOrOptions?: string | JsonlOptions,
): Promise<void> {
  let options: JsonlOptions;
  let schema: JsonSchema | undefined;
  if (typeof schemaOrOptions === "string") {
    schema = await loadSchema(schemaOrOptions);
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
  const floatFields = new Set(options.floatFields ?? Object.entries(schema?.properties ?? {}).flatMap(([key, definition]) => {
    if (typeof definition !== "object" || definition === null || !("type" in definition)) return [];
    const type = (definition as { type?: string | string[] }).type;
    return (typeof type === "string" ? [type] : type ?? []).includes("number") ? [key] : [];
  }));
  if (typeof schemaOrOptions === "string" && schemaOrOptions === "inventory_event") {
    floatFields.add("from");
    floatFields.add("to");
  }
  const output = sorted.map((row) => stringifyRow(ordered(row, options.fieldOrder), floatFields)).join("\n");
  await atomicWrite(filePath, output ? `${output}\n` : "");
}
