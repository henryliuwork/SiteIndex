import { open, lstat, link, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
const TRACKING_QUERY = /^(utm_|gclid$|gbraid$|wbraid$|srsltid$|fbclid$|mc_|_ga$)/i;
const SENSITIVE_QUERY = /(?:token|secret|password|credential|authorization|api[_-]?key|access[_-]?key|signature)/i;

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
  for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY.test(key)) return null;
  const pairs = [...url.searchParams.entries()]
    .filter(([key, queryValue]) => queryValue !== "" && !TRACKING_QUERY.test(key))
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
  const content = `${GENERATED_MARKER}\n# EDM SKU Index\n\n${TABLE_HEADER}\n${TABLE_SEPARATOR}\n${table.join("\n")}\n`;
  return { content, skuCount: rows.length, missingImageCount };
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

type SafeTargetState =
  | { kind: "missing" }
  | {
    kind: "file";
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    content: Buffer;
  };

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev !== 0 && left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
}

async function projectRootIdentity(projectPath: string): Promise<{ root: string; identity: DirectoryIdentity }> {
  let root: string;
  try { root = await realpath(projectPath); }
  catch { throw safeError("PROJECT_UNREADABLE", "无法确认项目目录，未写入清单。"); }
  const stats = await lstat(root).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink() || stats.ino === 0) {
    throw conflict("无法安全确认项目根目录，未写入清单。");
  }
  return { root, identity: { path: root, dev: stats.dev, ino: stats.ino } };
}

function targetAbsolutePath(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw conflict("清单路径超出项目目录，未写入文件。");
  }
  return target;
}

async function ensureSafeParent(projectPath: string, relativePath: string): Promise<{
  root: string;
  target: string;
  parent: string;
  chain: DirectoryIdentity[];
}> {
  const { root, identity } = await projectRootIdentity(projectPath);
  const paths = relativePath.split(/[\\/]/u);
  if (paths.some((part) => !part || part === "." || part === "..") || path.isAbsolute(relativePath)) {
    throw conflict("清单路径无效，未写入文件。");
  }
  const target = targetAbsolutePath(root, relativePath);
  const parent = path.dirname(target);
  const directoryNames = path.relative(root, parent).split(path.sep).filter(Boolean);
  const chain = [identity];
  let current = root;

  for (const name of directoryNames) {
    current = path.join(current, name);
    let stats;
    try { stats = await lstat(current); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw conflict("无法安全检查清单目录，未写入文件。");
      try { await mkdir(current); }
      catch (createError) {
        if (errorCode(createError) !== "EEXIST") throw safeError("WRITE_FAILED", "无法创建清单目录，未写入清单。");
      }
      try { stats = await lstat(current); }
      catch { throw conflict("清单目录在检查期间发生变化，未写入文件。"); }
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.ino === 0) {
      throw conflict("清单目录包含符号链接或类型异常，未写入文件。");
    }
    let canonical: string;
    try { canonical = await realpath(current); }
    catch { throw conflict("无法确认清单目录，未写入文件。"); }
    if (path.resolve(canonical) !== path.resolve(current)) {
      throw conflict("清单目录指向项目外部，未写入文件。");
    }
    chain.push({ path: current, dev: stats.dev, ino: stats.ino });
  }
  await assertSafeChain(projectPath, root, chain);
  return { root, target, parent, chain };
}

async function assertSafeChain(projectPath: string, root: string, chain: readonly DirectoryIdentity[]): Promise<void> {
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(projectPath); }
  catch { throw conflict("项目路径在写入期间发生变化，未修改清单。"); }
  if (path.resolve(canonicalRoot) !== path.resolve(root)) {
    throw conflict("项目路径在写入期间发生变化，未修改清单。");
  }
  for (const expected of chain) {
    let stats;
    try { stats = await lstat(expected.path); }
    catch { throw conflict("清单目录在写入期间发生变化，未修改清单。"); }
    if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(expected, stats)) {
      throw conflict("清单目录在写入期间被替换，未修改清单。");
    }
    let canonical: string;
    try { canonical = await realpath(expected.path); }
    catch { throw conflict("清单目录在写入期间发生变化，未修改清单。"); }
    if (path.resolve(canonical) !== path.resolve(expected.path)) {
      throw conflict("清单目录指向项目外部，未修改清单。");
    }
  }
}

async function inspectTarget(target: string): Promise<SafeTargetState> {
  let before;
  try { before = await lstat(target); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    throw conflict("无法安全读取现有清单，未修改文件。");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0) {
    throw conflict("目标清单不是可安全管理的普通文件，未做修改。");
  }
  let content: Buffer;
  try { content = await readFile(target); }
  catch { throw conflict("无法安全读取现有清单，未修改文件。"); }
  let after;
  try { after = await lstat(target); }
  catch { throw conflict("目标清单在读取期间发生变化，未修改文件。"); }
  if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(before, after)
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw conflict("目标清单在读取期间发生变化，未修改文件。");
  }
  return {
    kind: "file", dev: after.dev, ino: after.ino, size: after.size,
    mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, content,
  };
}

function isManagedMarkdown(content: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return text.split(/\r?\n/u, 1)[0] === GENERATED_MARKER;
  } catch { return false; }
}

function assertExistingContent(state: SafeTargetState, expected: Buffer): "unchanged" {
  if (state.kind !== "file" || !state.content || !isManagedMarkdown(state.content)) throw conflict();
  if (!state.content.equals(expected)) {
    throw conflict("受管清单内容已变化；当前文件系统没有可验证的条件替换操作，本次保留原文件。");
  }
  return "unchanged";
}

async function removeTemp(tempPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await unlink(tempPath); return; }
    catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 8) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/** Safely creates the fixed generated file without replacing a concurrent creator. Updates remain gated until a CAS primitive is verified. */
export async function createEdmSkuIndexFile(
  projectPath: string,
  layout: ProjectLayout,
  content: string,
): Promise<"created" | "unchanged"> {
  const relativePath = pathsFor(layout).edmSkuIndex;
  const { root, target, parent, chain } = await ensureSafeParent(projectPath, relativePath);
  const expected = Buffer.from(content, "utf8");
  const initial = await inspectTarget(target);
  if (initial.kind === "file") return assertExistingContent(initial, expected);

  const tempPath = path.join(parent, `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  let tempCreated = false;
  let linked = false;
  try {
    handle = await open(tempPath, "wx");
    tempCreated = true;
    await handle.writeFile(expected);
    await handle.sync();
    const tempIdentity = await handle.stat();
    await handle.close();
    handle = undefined;

    await assertSafeChain(projectPath, root, chain);
    const beforeCommit = await inspectTarget(target);
    if (beforeCommit.kind === "file") return assertExistingContent(beforeCommit, expected);

    try {
      await link(tempPath, target);
      linked = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        const raced = await inspectTarget(target);
        if (raced.kind === "file") return assertExistingContent(raced, expected);
        throw conflict("清单目标在创建期间发生变化，未覆盖现有文件。");
      }
      const current = await inspectTarget(target).catch(() => null);
      if (current?.kind === "file" && current.content?.equals(expected) && isManagedMarkdown(current.content)) return "unchanged";
      if (!current) throw safeError("EDM_EXPORT_OUTCOME_UNKNOWN", "清单写入结果暂无法确认，可重新生成以核对。");
      if (current.kind === "file") throw conflict("清单目标在创建期间发生变化，未覆盖现有文件。");
      throw safeError("WRITE_FAILED", "无法安全创建 EDM SKU 清单；目标文件未确认写入。");
    }

    await assertSafeChain(projectPath, root, chain);
    const committed = await inspectTarget(target);
    if (committed.kind !== "file" || !sameIdentity(tempIdentity, committed)
      || !committed.content?.equals(expected) || !isManagedMarkdown(committed.content)) {
      throw conflict("清单目标在创建期间被替换或改写；保留当前文件。");
    }
    await removeTemp(tempPath);
    tempCreated = false;
    await assertSafeChain(projectPath, root, chain);
    const verified = await inspectTarget(target);
    if (verified.kind !== "file" || !sameIdentity(tempIdentity, verified)
      || !verified.content?.equals(expected) || !isManagedMarkdown(verified.content)) {
      throw safeError("EDM_EXPORT_OUTCOME_UNKNOWN", "清单写入结果暂无法确认，可重新生成以核对。");
    }
    return "created";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
      && (error.code === "EDM_INDEX_CONFLICT" || error.code === "EDM_EXPORT_OUTCOME_UNKNOWN" || error.code === "WRITE_FAILED")) throw error;
    if (linked) throw safeError("EDM_EXPORT_OUTCOME_UNKNOWN", "清单写入结果暂无法确认，可重新生成以核对。");
    throw safeError("WRITE_FAILED", "无法安全创建 EDM SKU 清单；目标文件未修改。");
  } finally {
    await handle?.close().catch(() => undefined);
    if (tempCreated) await removeTemp(tempPath).catch(() => undefined);
  }
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
