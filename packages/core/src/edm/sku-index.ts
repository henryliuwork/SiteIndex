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
import { currencyMinorDigits } from "./currency";

const GENERATED_MARKER = "<!-- siteindex:generated:edm-sku-index:v1 -->";
const TABLE_HEADER = "| SKU | 标题 | 短描述 | URL | 图片 URL | 原价 | 折扣价 | 库存 |";
const TABLE_SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const TRACKING_QUERY = /^(utm_|gclid$|gbraid$|wbraid$|srsltid$|fbclid$|mc_|_ga$)/u;

export interface EdmSkuIndexInput {
  products: readonly ProductView[];
  skus: readonly SkuRecord[];
  stock: readonly SkuStockView[];
  skuMedia: readonly CsvRow[];
  skuTags: readonly CsvRow[];
  siteCurrency: string;
  discountTiers?: readonly number[];
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
  currency: string;
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

interface PublicUrlResult {
  url: string | null;
  needsReview: boolean;
}

function normalizePublicUrl(value: unknown, variantSkus: readonly string[] = []): PublicUrlResult {
  if (typeof value !== "string" || !value.trim()) return { url: null, needsReview: false };
  let url: URL;
  try { url = new URL(value); } catch { return { url: null, needsReview: true }; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    return { url: null, needsReview: true };
  }
  const safePairs: Array<[string, string]> = [];
  for (const [rawKey, queryValue] of url.searchParams.entries()) {
    const key = rawKey.normalize("NFKC").toLowerCase();
    if (TRACKING_QUERY.test(key)) continue;
    if (key === "variant" && variantSkus.includes(queryValue) && safePairs.length === 0) {
      safePairs.push(["variant", queryValue]);
      continue;
    }
    // An opaque value under a familiar key can still be a token. Keep the source URL out and ask for review.
    return { url: null, needsReview: true };
  }
  url.search = "";
  for (const [key, queryValue] of safePairs) url.searchParams.append(key, queryValue);
  return { url: url.href, needsReview: false };
}

function supportedImageUrl(value: unknown): PublicUrlResult {
  const normalized = normalizePublicUrl(value);
  if (!normalized.url) return normalized;
  const extension = path.posix.extname(new URL(normalized.url).pathname).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" || extension === ".png"
    ? normalized
    : { url: null, needsReview: false };
}

/** Sanitizes a stored image source for read-only reporting, regardless of format; performs no network request. */
export function normalizeEdmImageSourceUrl(value: unknown): string | null {
  return normalizePublicUrl(value).url;
}

/** Returns only an EDM-compatible, sanitized public image URL. This performs no network request. */
export function normalizeEdmImageUrl(value: unknown): string | null {
  return supportedImageUrl(value).url;
}

function markdownCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

export function configuredDiscountTiers(values: unknown): Set<number> {
  if (values === undefined) return new Set();
  if (!Array.isArray(values)) throw safeError("CONFIG_INVALID", "EDM 折扣档配置必须是整数数组。");
  const tiers: number[] = [];
  for (const value of values as unknown[]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 99) {
      throw safeError("CONFIG_INVALID", "EDM 折扣档配置必须是互不重复的 1 到 99 整数。");
    }
    tiers.push(value);
  }
  if (new Set(tiers).size !== tiers.length) {
    throw safeError("CONFIG_INVALID", "EDM 折扣档配置必须是互不重复的 1 到 99 整数。");
  }
  return new Set(tiers);
}

function decimalParts(value: number): { coefficient: bigint; scale: number } | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const [mantissa = "0", exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText ? Number(exponentText) : 0;
  const decimalPoint = mantissa.indexOf(".");
  const digits = mantissa.replace(".", "");
  let scale = (decimalPoint < 0 ? 0 : mantissa.length - decimalPoint - 1) - exponent;
  let coefficient = BigInt(digits || "0");
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function moneyMinorUnits(value: number | null, digits: number, percentage: number): string {
  if (value === null) return "";
  const decimal = decimalParts(value);
  if (!decimal) return "";
  const scale = 10n ** BigInt(decimal.scale);
  const unit = 10n ** BigInt(digits);
  const denominator = 100n * scale;
  const numerator = decimal.coefficient * BigInt(percentage) * unit;
  const minorUnits = (numerator + denominator / 2n) / denominator;
  if (digits === 0) return String(minorUnits);
  const whole = minorUnits / unit;
  const fraction = String(minorUnits % unit).padStart(digits, "0");
  return `${whole}.${fraction}`;
}

export function selectedTier(value: string | null | undefined, tiers: ReadonlySet<number>): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const tier = Number(value);
  return Number.isInteger(tier) && tiers.has(tier) ? tier : null;
}

export function latestLedgerRows(rows: readonly CsvRow[], key: string): Map<string, CsvRow> {
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
  const mediaBySku = latestLedgerRows(input.skuMedia.filter((row) => row.image_role === "main"), "sku");
  const products = input.grouping?.enabled
    ? groupProductRows(input.products, activeSkus, input.stock, input.grouping.rule, true)
    : input.products.map((row) => ({ ...row, row_kind: "single" as const }));
  const rows: ExportRow[] = [];
  const seen = new Set<string>();

  for (const product of [...products].sort((left, right) => compareKeys(left.handle, right.handle))) {
    if (product.status !== "active" || product.exclude_edm === 1) continue;
    if (product.row_kind === "parent") {
      const children = product.skus.filter((sku) => activeBySku.has(sku)).sort(compareKeys);
      const feedParent = input.grouping?.rule.type === "regex" && input.grouping.rule.parent_source === "feed"
        ? activeBySku.get(product.product_id) : undefined;
      const parentHasImage = feedParent && (supportedImageUrl(mediaBySku.get(feedParent.sku)?.image_url).url
        || supportedImageUrl(feedParent.image_url).url);
      const available = feedParent ? children.filter((sku) => supportedImageUrl(mediaBySku.get(sku)?.image_url).url
        || supportedImageUrl(activeBySku.get(sku)?.image_url).url) : children;
      const representative = parentHasImage ? feedParent.sku
        : available.find((sku) => stockBySku.get(sku)?.stock_status === "in_stock") ?? available[0] ?? children[0];
      if (!representative || seen.has(product.product_id)) continue;
      const representativeRecord = activeBySku.get(representative);
      if (!representativeRecord) continue;
      seen.add(product.product_id);
      rows.push({
        sku: product.product_id,
        product,
        representativeSku: representative,
        originalPrice: feedParent?.price ?? representativeRecord.price,
        currency: feedParent?.currency ?? representativeRecord.currency,
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
        currency: record.currency,
        stockStatus: stockBySku.get(sku)?.stock_status ?? "unknown",
      });
    }
  }
  return rows.sort((left, right) => compareKeys(left.sku, right.sku));
}

/** Renders deterministic prices using each canonical SKU row's explicitly selected discount tier. */
export function renderEdmSkuIndex(input: EdmSkuIndexInput): RenderedEdmSkuIndex {
  const mediaBySku = latestLedgerRows(input.skuMedia.filter((row) => row.image_role === "main"), "sku");
  const tagsBySku = latestLedgerRows(input.skuTags, "sku");
  const activeBySku = new Map(input.skus.filter((sku) => sku.status === "active").map((sku) => [sku.sku, sku]));
  const rows = exportRows(input);
  const tiers = configuredDiscountTiers(input.discountTiers);
  const siteCurrency = typeof input.siteCurrency === "string" ? input.siteCurrency.toUpperCase() : "";
  const siteDigits = currencyMinorDigits(input.siteCurrency);
  if (rows.length && siteDigits === null) {
    throw safeError("EDM_CURRENCY_INVALID", "项目币种无效或暂不支持，无法渲染 EDM 清单。");
  }
  let missingImageCount = 0;
  const table = rows.map(({ sku, product, representativeSku, originalPrice, currency, stockStatus }) => {
    const representative = activeBySku.get(representativeSku);
    const skuDigits = currencyMinorDigits(currency);
    if (skuDigits === null || currency.toUpperCase() !== siteCurrency || skuDigits !== siteDigits) {
      throw safeError("EDM_CURRENCY_INVALID", "商品币种与项目币种不一致或暂不支持，无法渲染 EDM 清单。");
    }
    const manualImage = supportedImageUrl(mediaBySku.get(representativeSku)?.image_url);
    const feedImage = supportedImageUrl(representative?.image_url);
    const image = manualImage.url ? manualImage : feedImage;
    const tag = tagsBySku.get(sku) ?? tagsBySku.get(representativeSku);
    const tier = selectedTier(tagsBySku.get(sku)?.discount_tier, tiers);
    if (!image.url) missingImageCount += 1;
    const url = normalizePublicUrl(product.url, product.skus);
    const cells = [
      sku,
      product.title,
      typeof tag?.email_blurb === "string" ? tag.email_blurb : "",
      url.url ?? (url.needsReview ? "链接待确认（原链接含未识别参数）" : ""),
      image.url ?? (manualImage.needsReview || feedImage.needsReview ? "待补图（原图片链接含未识别参数）" : "待补图"),
      moneyMinorUnits(originalPrice, skuDigits, 100),
      tier === null ? "" : moneyMinorUnits(originalPrice, skuDigits, 100 - tier),
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
