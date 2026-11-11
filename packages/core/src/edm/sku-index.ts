import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  EdmSkuIndexExportResult,
  ProjectLayout,
  ProductView,
  SkuRecord,
  SkuStockView,
  StockStatus,
} from "@siteindex/shared";
import { pathsFor } from "@siteindex/shared";
import type { CsvRow } from "../io/csv";
import { compareKeys } from "../io/compare";
import { groupProductRows } from "../products/parent-view";
import type { SiteIndexError } from "@siteindex/shared";

const GENERATED_MARKER = "<!-- siteindex:generated:edm-sku-index:v1 -->";
const TABLE_HEADER = "| SKU | 标题 | 短描述 | URL | 图片 URL | 原价 | 折扣价 | 库存 |";
const TABLE_SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const SAFE_PUBLIC_QUERY_KEYS = new Set(["color", "size", "variant", "option"]);

export interface EdmSkuIndexInput {
  products: readonly ProductView[];
  skus: readonly SkuRecord[];
  stock: readonly SkuStockView[];
  skuMedia: readonly CsvRow[];
  skuTags: readonly CsvRow[];
  grouping?: { enabled: boolean; rule: Parameters<typeof groupProductRows>[3] };
}

export interface RenderedEdmSkuIndex {
  content: string;
  skuCount: number;
  missingImageCount: number;
}

interface ExportRow {
  sku: string;
  product: ProductView;
  representativeSku: string;
  originalPrice: number | null;
  stockStatus: StockStatus;
}

function safeError(code: SiteIndexError["code"], message: string): SiteIndexError {
  return { code, message };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function conflict(message = "目标清单由用户或 EDM 技能维护，未做修改。"): SiteIndexError {
  return safeError("EDM_INDEX_CONFLICT", message);
}

function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  const pairs = [...url.searchParams.entries()]
    .map(([key, queryValue]) => [key.normalize("NFKC").toLowerCase(), queryValue] as const)
    .filter(([key, queryValue]) => SAFE_PUBLIC_QUERY_KEYS.has(key) && queryValue !== "")
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => compareKeys(leftKey, rightKey) || compareKeys(leftValue, rightValue));
  url.search = "";
  for (const [key, queryValue] of pairs) url.searchParams.append(key, queryValue);
  url.hash = "";
  return url.href;
}

function supportedImageUrl(value: unknown): string | null {
  const normalized = normalizePublicUrl(value);
  if (!normalized) return null;
  const extension = path.posix.extname(new URL(normalized).pathname).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" || extension === ".png" ? normalized : null;
}

function markdownCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function money(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  return String(Object.is(value, -0) ? 0 : value);
}

function latestLedgerRows(rows: readonly CsvRow[], key: string): Map<string, CsvRow> {
  const selected = new Map<string, CsvRow>();
  for (const row of [...rows].sort((left, right) =>
    compareKeys(String(left[key] ?? ""), String(right[key] ?? ""))
    || compareKeys(String(right.updated_at ?? ""), String(left.updated_at ?? ""))
    || compareKeys(String(left.image_url ?? left.email_blurb ?? ""), String(right.image_url ?? right.email_blurb ?? "")))) {
    const value = String(row[key] ?? "");
    if (value && !selected.has(value)) selected.set(value, row);
  }
  return selected;
}

function exportRows(input: EdmSkuIndexInput): ExportRow[] {
  const activeSkus = input.skus.filter((sku) => sku.status === "active");
  const activeBySku = new Map(activeSkus.map((sku) => [sku.sku, sku]));
  const stockBySku = new Map(input.stock.map((row) => [row.sku, row]));
  const products = input.grouping?.enabled
    ? groupProductRows(input.products, activeSkus, input.stock, input.grouping.rule, true)
    : input.products.map((row) => ({ ...row, row_kind: "single" as const }));
  const rows: ExportRow[] = [];
  const seen = new Set<string>();

  for (const product of [...products].sort((left, right) => compareKeys(left.handle, right.handle))) {
    if (product.status !== "active" || product.exclude_edm === 1) continue;
    if (product.row_kind === "parent") {
      const children = product.skus.filter((sku) => activeBySku.has(sku)).sort(compareKeys);
      const representative = children.find((sku) => stockBySku.get(sku)?.stock_status === "in_stock") ?? children[0];
      if (!representative || seen.has(product.product_id)) continue;
      const representativeRecord = activeBySku.get(representative);
      if (!representativeRecord) continue;
      seen.add(product.product_id);
      rows.push({
        sku: product.product_id,
        product,
        representativeSku: representative,
        originalPrice: representativeRecord.price,
        stockStatus: product.stock_status,
      });
      continue;
    }

    for (const sku of [...product.skus].sort(compareKeys)) {
      const record = activeBySku.get(sku);
      if (!record || seen.has(sku)) continue;
      seen.add(sku);
      rows.push({
        sku,
        product,
        representativeSku: sku,
        originalPrice: record.price,
        stockStatus: stockBySku.get(sku)?.stock_status ?? "unknown",
      });
    }
  }
  return rows.sort((left, right) => compareKeys(left.sku, right.sku));
}

/** Renders only deterministic project data; discount tiers remain blank until their business rule is defined. */
export function renderEdmSkuIndex(input: EdmSkuIndexInput): RenderedEdmSkuIndex {
  const mediaBySku = latestLedgerRows(input.skuMedia.filter((row) => row.image_role === "main"), "sku");
  const tagsBySku = latestLedgerRows(input.skuTags, "sku");
  const activeBySku = new Map(input.skus.filter((sku) => sku.status === "active").map((sku) => [sku.sku, sku]));
  const rows = exportRows(input);
  let missingImageCount = 0;
  const table = rows.map(({ sku, product, representativeSku, originalPrice, stockStatus }) => {
    const representative = activeBySku.get(representativeSku);
    const manualImage = supportedImageUrl(mediaBySku.get(representativeSku)?.image_url);
    const feedImage = supportedImageUrl(representative?.image_url);
    const image = manualImage ?? feedImage;
    if (!image) missingImageCount += 1;
    const tag = tagsBySku.get(sku) ?? tagsBySku.get(representativeSku);
    const url = normalizePublicUrl(product.url);
    const cells = [
      sku,
      product.title,
      typeof tag?.email_blurb === "string" ? tag.email_blurb : "",
      url ?? "",
      image ?? "待补图",
      money(originalPrice),
      "", // Discount tier selection and rounding are intentionally pending product decisions.
      stockStatus,
    ];
    return `| ${cells.map(markdownCell).join(" | ")} |`;
  });
  const content = `${[
    GENERATED_MARKER,
    "# EDM SKU Index",
    "",
    TABLE_HEADER,
    TABLE_SEPARATOR,
    ...table,
  ].join("\n")}\n`;
  return { content, skuCount: rows.length, missingImageCount };
}

async function validateEdmTargetPath(projectPath: string, layout: ProjectLayout): Promise<void> {
  let root: string;
  try { root = await realpath(projectPath); }
  catch { throw safeError("PROJECT_UNREADABLE", "无法确认项目目录，未写入清单。"); }
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw conflict("无法安全确认项目根目录，未写入清单。");
  }

  const relativePath = pathsFor(layout).edmSkuIndex;
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
    throw conflict("清单路径无效，未写入文件。");
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw conflict("清单路径超出项目目录，未写入文件。");
  }

  let current = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stats;
    try { stats = await lstat(current); }
    catch (error) {
      if (errorCode(error) === "ENOENT") break;
      throw conflict("无法安全检查清单目录，未写入文件。");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw conflict("清单目录包含符号链接或类型异常，未写入文件。");
    let canonical: string;
    try { canonical = await realpath(current); }
    catch { throw conflict("无法确认清单目录，未写入文件。"); }
    if (path.resolve(canonical) !== path.resolve(current)) throw conflict("清单目录指向项目外部，未写入文件。");
  }
}

interface EdmSkuIndexTestHooks {
  /** Deterministically injects a path race after the read-only validation boundary. */
  afterPathValidation?: () => Promise<void>;
}

function outcomeUnknown(): SiteIndexError {
  return safeError("EDM_EXPORT_OUTCOME_UNKNOWN", "清单写入可能已完成，但结果无法确认；请重新生成核对。");
}

/** Converts any failure after an atomic commit into an explicit unknown outcome. */
export async function confirmEdmIndexPostCommit<T>(verify: () => Promise<T>): Promise<T> {
  try { return await verify(); }
  catch { throw outcomeUnknown(); }
}

/**
 * Validates the destination read-only, then refuses to write because Node's path-based APIs
 * cannot bind a no-follow directory identity to the final create/link operation.
 * A native bound-directory writer must be added before enabling file creation.
 */
export async function createEdmSkuIndexFile(
  projectPath: string,
  layout: ProjectLayout,
  _content: string,
  testHooks?: EdmSkuIndexTestHooks,
): Promise<"created" | "unchanged"> {
  await validateEdmTargetPath(projectPath, layout);
  await testHooks?.afterPathValidation?.();
  throw conflict("当前 Core 没有可验证的目录句柄/no-follow 写入能力，未创建或覆盖清单。");
}
export function edmIndexResult(
  status: "created" | "updated" | "unchanged",
  path: EdmSkuIndexExportResult["path"],
  rendered: RenderedEdmSkuIndex,
): EdmSkuIndexExportResult {
  return {
    status,
    path,
    sku_count: rendered.skuCount,
    missing_image_count: rendered.missingImageCount,
  };
}
