import { readFile } from "node:fs/promises";
import { CSV_HEADERS } from "@siteindex/shared";
import { atomicWrite } from "./atomic-write";
import { compareKeys } from "./compare";

export type CsvRow = Record<string, string | null>;

function parseCsv(text: string, filePath: string): CsvRow[] {
  const source = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); table.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error(`${filePath}: CSV 引号未闭合`);
  if (cell.length || row.length) { row.push(cell); table.push(row); }
  if (!table.length) return [];
  const headers = table[0]!;
  return table.slice(1).filter((cells) => !(cells.length === 1 && cells[0] === ""))
    .map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] === "" || cells[i] === undefined ? null : cells[i]])));
}

export async function readCsv(filePath: string): Promise<CsvRow[]> {
  let source: string;
  try { source = await readFile(filePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseCsv(source, filePath);
}

function pyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function encodeCell(value: unknown): string {
  const text = pyCsvValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV 列顺序由 shared 的 CSV_HEADERS 传入；排序按 Python 的逐字符串比较。 */
export async function writeCsv(
  filePath: string,
  rows: readonly Record<string, unknown>[],
  headers: readonly string[],
  primaryKey: readonly string[],
): Promise<void> {
  const fixedHeaders = Object.values(CSV_HEADERS).find((candidate) =>
    candidate.length === headers.length && candidate.every((header, index) => header === headers[index]),
  );
  if (!fixedHeaders) throw new Error("CSV 表头必须来自 @siteindex/shared 的 CSV_HEADERS");
  const sorted = [...rows].sort((a, b) => {
    for (const key of primaryKey) {
      const av = a[key] === null || a[key] === undefined ? "" : String(a[key]);
      const bv = b[key] === null || b[key] === undefined ? "" : String(b[key]);
      const order = compareKeys(av, bv);
      if (order) return order;
    }
    return 0;
  });
  const lines = [fixedHeaders.map(encodeCell).join(","), ...sorted.map((row) => fixedHeaders.map((header) => encodeCell(row[header])).join(","))];
  await atomicWrite(filePath, `${lines.join("\n")}\n`);
}
