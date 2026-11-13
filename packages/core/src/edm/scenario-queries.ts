import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EdmCampaignSafetyData,
  EdmCampaignSafetyFinding,
  EdmCampaignSafetyQuery,
  EdmCampaign,
  EdmCandidate,
  EdmCandidatesData,
  EdmCandidatesQuery,
  EdmMediaGap,
  EdmMediaGapsData,
  EdmMediaGapsQuery,
  ScenarioAnomaly,
  ScenarioQueryResult,
  ScenarioResultMetadata,
  ScenarioSource,
  SkuGroupingRule,
  SkuRecord,
  StockStatus,
} from "@siteindex/shared";
import { CSV_HEADERS, JOB_NAMES } from "@siteindex/shared";
import { parseCsv, type CsvRow } from "../io/csv";
import { compareKeys } from "../io/compare";
import { parseJsonl, type JsonRecord } from "../io/jsonl";
import { pathsForProject } from "../io/project-layout";
import { groupSkuIds } from "../inventory/sku-grouping";
import { normalizeEdmImageSourceUrl, normalizeEdmImageUrl } from "./sku-index";

type SourceState = "ok" | "missing" | "invalid" | "unreadable";

interface SourceRows<T> {
  field: string;
  source: ScenarioSource;
  state: SourceState;
  rows: T[] | null;
}

interface SiteEdmSettings {
  currency: string;
  cooldownDays: number;
  imagePriority: readonly ("feed" | "manual")[];
  discountTiers: readonly number[] | null;
  grouping: { enabled: boolean; rule: SkuGroupingRule } | null;
}

interface SiteSource extends Omit<SourceRows<SiteEdmSettings>, "rows"> {
  rows: SiteEdmSettings | null;
}

interface EdmSources {
  skus: SourceRows<SkuRecord>;
  stock: SourceRows<StockRow>;
  media: SourceRows<CsvRow>;
  tags: SourceRows<CsvRow>;
  campaigns: SourceRows<EdmCampaign>;
  site: SiteSource;
  runs: SourceRows<DailyRunRow>;
}

interface StockRow { sku: string; stock_status: StockStatus }
interface DailyRunRow { job: string; status: string; started_at: string; finished_at: string | null }

interface CandidateRow {
  candidate: EdmCandidate;
  discountTierRaw: string | null;
  currencyMismatch: boolean;
  feedImageUrl: string | null;
  manualImageUrl: string | null;
  feedSourceUrl: string | null;
  manualSourceUrl: string | null;
  feedImagePresent: boolean;
  manualImagePresent: boolean;
}

const STOCK_STATUS = new Set<StockStatus>(["in_stock", "out_of_stock", "preorder", "unknown"]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function object(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function date(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSku(value: JsonRecord): value is JsonRecord & SkuRecord {
  return typeof value.sku === "string" && typeof value.product_id === "string" && typeof value.handle === "string"
    && typeof value.title === "string" && typeof value.url === "string" && typeof value.category === "string"
    && typeof value.price === "number" && Number.isFinite(value.price)
    && (value.compare_at_price === null || (typeof value.compare_at_price === "number" && Number.isFinite(value.compare_at_price)))
    && typeof value.currency === "string" && nullableString(value.image_url)
    && (value.status === "active" || value.status === "removed");
}

function isStock(value: JsonRecord): value is JsonRecord & StockRow {
  return typeof value.sku === "string" && typeof value.title === "string"
    && typeof value.stock_status === "string" && STOCK_STATUS.has(value.stock_status as StockStatus)
    && typeof value.price === "number" && Number.isFinite(value.price);
}

function isCampaign(value: JsonRecord): value is JsonRecord & EdmCampaign {
  return typeof value.campaign_id === "string" && typeof value.theme === "string"
    && (value.status === "draft" || value.status === "scheduled" || value.status === "sent")
    && date(value.date) && stringArray(value.handles)
    && (value.send_date === undefined || value.send_date === null || date(value.send_date));
}

const JOB_NAME_SET = new Set<string>(JOB_NAMES);

function isRun(value: JsonRecord): value is JsonRecord & DailyRunRow {
  return typeof value.job === "string" && JOB_NAME_SET.has(value.job)
    && timestamp(value.started_at) && (value.finished_at === null || timestamp(value.finished_at))
    && (value.status === "ok" || value.status === "partial" || value.status === "failed" || value.status === "skipped");
}

function fieldSource(field: string, label: string): ScenarioSource {
  return { kind: field, label };
}

function errorCode(error: unknown): string | undefined {
  return object(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readJsonlSource<T extends object>(
  projectPath: string,
  relativePath: string,
  field: string,
  label: string,
  validator: (row: JsonRecord) => row is JsonRecord & T,
): Promise<SourceRows<T>> {
  const source = fieldSource(field, label);
  let text: string;
  try { text = await readFile(path.join(projectPath, relativePath), "utf8"); }
  catch (error) {
    const code = errorCode(error);
    return { field, source, state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", rows: null };
  }
  try {
    const parsed = parseJsonl(text, label);
    const rows: T[] = [];
    for (const row of parsed) {
      if (!validator(row)) return { field, source, state: "invalid", rows: null };
      rows.push(row);
    }
    return { field, source, state: "ok", rows };
  } catch {
    return { field, source, state: "invalid", rows: null };
  }
}

async function readCsvSource(
  projectPath: string,
  relativePath: string,
  field: string,
  label: string,
  allowedHeaders: readonly (readonly string[])[],
): Promise<SourceRows<CsvRow>> {
  const source = fieldSource(field, label);
  let text: string;
  try { text = await readFile(path.join(projectPath, relativePath), "utf8"); }
  catch (error) {
    const code = errorCode(error);
    return { field, source, state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", rows: null };
  }
  try {
    const headerLine = text.replace(/^\uFEFF/u, "").split(/\r?\n/u, 1)[0] ?? "";
    if (!allowedHeaders.some((headers) => headers.join(",") === headerLine)) return { field, source, state: "invalid", rows: null };
    return { field, source, state: "ok", rows: parseCsv(text, label) };
  }
  catch { return { field, source, state: "invalid", rows: null }; }
}

function isMediaLedgerRow(row: CsvRow): boolean {
  return typeof row.sku === "string" && row.sku.length > 0
    && (row.image_role === "main" || row.image_role === "alt" || row.image_role === "lifestyle")
    && typeof row.image_url === "string" && row.image_url.length > 0
    && date(row.updated_at);
}

function isTagLedgerRow(row: CsvRow): boolean {
  return typeof row.sku === "string" && row.sku.length > 0
    && nullableString(row.tags) && nullableString(row.priority)
    && (row.exclude_edm === null || row.exclude_edm === "0" || row.exclude_edm === "1")
    && nullableString(row.note) && date(row.updated_at)
    && (!Object.hasOwn(row, "discount_tier") || nullableString(row.discount_tier));
}

async function readSiteSource(projectPath: string, relativePath: string): Promise<SiteSource> {
  const field = "site.edm";
  const source = fieldSource(field, "项目 EDM 配置");
  let text: string;
  try { text = await readFile(path.join(projectPath, relativePath), "utf8"); }
  catch (error) {
    const code = errorCode(error);
    return { field, source, state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", rows: null };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value) || typeof value.currency !== "string" || !value.currency.trim()) throw new Error("invalid site config");
    const rawEdm = value.edm === undefined ? {} : value.edm;
    if (!object(rawEdm)) throw new Error("invalid EDM config");
    const cooldownDays = rawEdm.cooldown_days === undefined ? 21 : rawEdm.cooldown_days;
    if (typeof cooldownDays !== "number" || !Number.isInteger(cooldownDays) || cooldownDays < 0) throw new Error("invalid cooldown");
    const imagePriority: unknown = rawEdm.image_priority === undefined ? ["feed", "manual"] : rawEdm.image_priority;
    if (!Array.isArray(imagePriority) || imagePriority.length !== 2
      || !imagePriority.includes("feed") || !imagePriority.includes("manual")) throw new Error("invalid image priority");
    let discountTiers: number[] | null = null;
    if (rawEdm.discount_tiers !== undefined) {
      if (!Array.isArray(rawEdm.discount_tiers) || !rawEdm.discount_tiers.every((tier) => typeof tier === "number" && Number.isInteger(tier) && tier >= 1 && tier <= 99)
        || new Set(rawEdm.discount_tiers).size !== rawEdm.discount_tiers.length) throw new Error("invalid discount tiers");
      discountTiers = [...rawEdm.discount_tiers];
    }
    let grouping: SiteEdmSettings["grouping"] = null;
    if (value.sku_grouping !== undefined) {
      if (!object(value.sku_grouping) || typeof value.sku_grouping.enabled !== "boolean") throw new Error("invalid grouping");
      const rawRule = value.sku_grouping.rule;
      if (!object(rawRule) || (rawRule.type !== "suffix" && rawRule.type !== "separator" && rawRule.type !== "regex")
        || typeof rawRule.value !== "string" || !rawRule.value.trim()) throw new Error("invalid grouping rule");
      if (rawRule.type === "regex" && rawRule.parent_source !== undefined && rawRule.parent_source !== "derived" && rawRule.parent_source !== "feed") throw new Error("invalid parent source");
      grouping = { enabled: value.sku_grouping.enabled, rule: rawRule.type === "regex"
        ? { type: "regex", value: rawRule.value, ...(rawRule.parent_source ? { parent_source: rawRule.parent_source as "derived" | "feed" } : {}) }
        : { type: rawRule.type, value: rawRule.value } };
    }
    const priority: ("feed" | "manual")[] = imagePriority[0] === "feed" ? ["feed", "manual"] : ["manual", "feed"];
    return {
      field, source, state: "ok",
      rows: { currency: value.currency.toUpperCase(), cooldownDays, imagePriority: priority, discountTiers, grouping },
    };
  } catch {
    return { field, source, state: "invalid", rows: null };
  }
}

async function readEdmSources(projectPath: string): Promise<EdmSources> {
  const paths = await pathsForProject(projectPath);
  const [skus, stock, media, tags, campaigns, site, runs] = await Promise.all([
    readJsonlSource(projectPath, paths.skus, "catalog.skus", "商品 SKU 目录", isSku),
    readJsonlSource(projectPath, paths.skuStockView, "views.sku_stock", "SKU 库存视图", isStock),
    readCsvSource(projectPath, paths.skuMedia, "ledgers.sku_media", "SKU 图片台账", [CSV_HEADERS.skuMedia, CSV_HEADERS.skuMediaV2]),
    readCsvSource(projectPath, paths.skuTags, "ledgers.sku_tags", "SKU EDM 标签台账", [CSV_HEADERS.skuTags, CSV_HEADERS.skuTagsV2]),
    readJsonlSource(projectPath, paths.edmCampaigns, "ledgers.edm_campaigns", "EDM 活动台账", isCampaign),
    readSiteSource(projectPath, paths.site),
    readJsonlSource(projectPath, paths.runs, "logs.runs", "Job 运行记录", isRun),
  ]);
  if (media.state === "ok" && media.rows && !media.rows.every(isMediaLedgerRow)) {
    media.state = "invalid";
    media.rows = null;
  }
  if (tags.state === "ok" && tags.rows && !tags.rows.every(isTagLedgerRow)) {
    tags.state = "invalid";
    tags.rows = null;
  }
  return { skus, stock, media, tags, campaigns, site, runs };
}

function sourceRows(sources: EdmSources): { field: string; source: ScenarioSource; state: SourceState }[] {
  return [sources.skus, sources.stock, sources.media, sources.tags, sources.campaigns, sources.site, sources.runs]
    .map(({ field, source, state }) => ({ field, source, state }));
}

function anomaly(code: string, severity: ScenarioAnomaly["severity"], message: string, field?: string): ScenarioAnomaly {
  return { code, severity, message, ...(field ? { field } : {}) };
}

function metadata(sources: EdmSources, extras: readonly ScenarioAnomaly[] = [], missingExtras: readonly string[] = []): ScenarioResultMetadata {
  const rows = sourceRows(sources);
  const missing = new Set(missingExtras);
  const anomalies = [...extras];
  for (const item of extras) {
    if (item.code === "SKU_STOCK_MISSING" && item.field) missing.add(item.field);
  }
  for (const source of rows) {
    if (source.state === "ok") continue;
    missing.add(source.field);
    if (source.state === "missing") anomalies.push(anomaly("SOURCE_MISSING", "warning", `${source.source.label ?? source.field}文件不存在。`, source.field));
    else if (source.state === "invalid") anomalies.push(anomaly("SOURCE_INVALID", "unreliable", `${source.source.label ?? source.field}包含无效记录，无法安全读取。`, source.field));
    else anomalies.push(anomaly("SOURCE_UNREADABLE", "unreliable", `${source.source.label ?? source.field}无法读取。`, source.field));
  }

  const runRows = sources.runs.state === "ok" ? sources.runs.rows ?? [] : [];
  const successfulDaily = runRows.filter((run) => run.job === "daily" && run.status === "ok" && run.finished_at !== null)
    .sort((left, right) => compareKeys(right.finished_at ?? "", left.finished_at ?? ""));
  const collectedAt = successfulDaily[0]?.finished_at ?? null;
  const latestDailyAttempt = runRows.filter((run) => run.job === "daily")
    .sort((left, right) => compareKeys(right.started_at, left.started_at))[0];
  if (collectedAt && latestDailyAttempt?.status !== undefined && latestDailyAttempt.status !== "ok") {
    anomalies.push(anomaly("DAILY_LATEST_NOT_SUCCESSFUL", "warning", "最近一次 daily 未成功，EDM 商品数据可能不是最新状态。", "logs.runs"));
  }
  if (!collectedAt) {
    missing.add("logs.runs.daily_success");
    anomalies.push(anomaly("DAILY_COLLECTION_UNKNOWN", "warning", "没有成功完成的 daily 记录，无法确认 EDM 商品数据的采集时间。", "logs.runs"));
  }
  const uniqueAnomalies = new Map<string, ScenarioAnomaly>();
  for (const item of anomalies) uniqueAnomalies.set(`${item.code}\u0000${item.field ?? ""}\u0000${item.message}`, item);
  const orderedAnomalies = [...uniqueAnomalies.values()].sort((left, right) => compareKeys(left.code, right.code)
    || compareKeys(left.field ?? "", right.field ?? "") || compareKeys(left.message, right.message));
  const missingFields = [...missing].sort(compareKeys);
  const uniqueSources = new Map(rows.map((item) => [item.source.kind, item.source]));
  const orderedSources = [...uniqueSources.values()].sort((left, right) => compareKeys(left.kind, right.kind));
  const quality = orderedAnomalies.some((item) => item.severity === "unreliable") ? "unreliable"
    : orderedAnomalies.length || missingFields.length ? "partial" : "complete";
  return { sources: orderedSources, collected_at: collectedAt, missing_fields: missingFields, quality, anomalies: orderedAnomalies };
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function parseTags(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(";").map(normalized).filter(Boolean))].sort(compareKeys);
}

function ledgerBySku(rows: readonly CsvRow[] | null, key: string): Map<string, CsvRow> {
  const sorted = [...(rows ?? [])].filter((row) => row.image_role === undefined || key !== "sku" || row.image_role === "main")
    .sort((left, right) => compareKeys(String(left[key] ?? ""), String(right[key] ?? ""))
      || compareKeys(String(right.updated_at ?? ""), String(left.updated_at ?? ""))
      || compareKeys(String(left.image_url ?? left.tags ?? ""), String(right.image_url ?? right.tags ?? "")));
  const selected = new Map<string, CsvRow>();
  for (const row of sorted) {
    const sku = String(row[key] ?? "");
    if (sku && !selected.has(sku)) selected.set(sku, row);
  }
  return selected;
}

function csvNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function csvTier(value: string | null | undefined): number | null {
  const parsed = csvNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function rawPresent(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function stockFor(sku: string, bySku: ReadonlyMap<string, StockRow[]>): StockStatus {
  const rows = bySku.get(sku) ?? [];
  return rows.length === 1 ? rows[0]!.stock_status : "unknown";
}

function commonCategory(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values.map(normalized).filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || compareKeys(left[0], right[0]))[0]?.[0] ?? null;
}

function groupedStatus(statuses: readonly StockStatus[]): StockStatus {
  if (statuses.includes("in_stock")) return "in_stock";
  if (statuses.length > 0 && statuses.every((status) => status === "out_of_stock")) return "out_of_stock";
  if (statuses.includes("preorder")) return "preorder";
  return "unknown";
}

function candidateRows(sources: EdmSources, parentOnly: boolean, extras: ScenarioAnomaly[], featuredThrough?: string): CandidateRow[] | null {
  if (sources.skus.state !== "ok" || !sources.skus.rows) return null;
  const skus = sources.skus.rows.filter((row) => row.status === "active").sort((left, right) => compareKeys(left.sku, right.sku));
  const skuCounts = new Map<string, number>();
  for (const sku of skus) skuCounts.set(sku.sku, (skuCounts.get(sku.sku) ?? 0) + 1);
  const duplicated = [...skuCounts].filter(([, count]) => count > 1).map(([sku]) => sku).sort(compareKeys);
  if (duplicated.length) {
    extras.push(anomaly("SKU_RECORD_DUPLICATE", "unreliable", "商品目录包含重复 SKU，无法安全生成 EDM 查询结果。", "catalog.skus.sku"));
    return null;
  }
  if (parentOnly && sources.site.state !== "ok") return null;
  if (parentOnly && sources.site.rows?.grouping?.enabled !== true) return baseCandidateRows(sources, featuredThrough);

  const base = baseCandidateRows(sources, featuredThrough);
  if (!parentOnly || !sources.site.rows?.grouping?.enabled || !sources.site.rows.grouping) return base;
  try {
    const grouping = groupSkuIds(skus.map((row) => row.sku), sources.site.rows.grouping.rule);
    const bySku = new Map(base.map((row) => [row.candidate.sku, row]));
    const children = new Set(grouping.groups.flatMap((group) => group.children));
    const rule = sources.site.rows.grouping.rule;
    const feedParents = rule.type === "regex" && rule.parent_source === "feed";
    const parentIds = new Set(feedParents ? grouping.groups.map((group) => group.parent) : []);
    const parents = grouping.groups.flatMap((group) => {
      const childRows = group.children.flatMap((sku) => bySku.get(sku) ? [bySku.get(sku)!] : []);
      const realParent = feedParents ? bySku.get(group.parent) : undefined;
      const parent = aggregateParent(group.parent, realParent ? [realParent, ...childRows] : childRows, sources.site.rows!.imagePriority);
      if (!parent) return [];
      return realParent ? [{ ...parent, candidate: { ...realParent.candidate,
        image_url: parent.candidate.image_url, image_source: parent.candidate.image_source } }] : [parent];
    });
    const singles = base.filter((row) => !children.has(row.candidate.sku) && !parentIds.has(row.candidate.sku));
    return [...parents, ...singles].sort((left, right) => compareKeys(left.candidate.sku, right.candidate.sku));
  } catch {
    extras.push(anomaly("SKU_GROUPING_RULE_INVALID", "unreliable", "项目 SKU 分组规则无效，无法生成父行查询结果。", "site.sku_grouping.rule"));
    return null;
  }
}

function baseCandidateRows(sources: EdmSources, featuredThrough?: string): CandidateRow[] {
  const skus = sources.skus.rows ?? [];
  const stockRows = sources.stock.rows ?? [];
  const stockBySku = new Map<string, StockRow[]>();
  for (const row of stockRows) stockBySku.set(row.sku, [...(stockBySku.get(row.sku) ?? []), row]);
  const media = ledgerBySku(sources.media.rows, "sku");
  const tags = ledgerBySku(sources.tags.rows, "sku");
  const featuredByHandle = new Map<string, string>();
  for (const campaign of sources.campaigns.rows ?? []) {
    const featuredDate = campaign.send_date || campaign.date;
    if (featuredThrough && featuredDate > featuredThrough) continue;
    for (const handle of campaign.handles) {
      if (featuredDate > (featuredByHandle.get(handle) ?? "")) featuredByHandle.set(handle, featuredDate);
    }
  }
  const priority = sources.site.rows?.imagePriority ?? ["feed", "manual"];
  return skus.filter((sku) => sku.status === "active").map((sku) => {
    const tag = tags.get(sku.sku);
    const mediaRow = media.get(sku.sku);
    const feedRaw = sku.image_url;
    const manualRaw = mediaRow?.image_url;
    const feedImage = normalizeEdmImageUrl(feedRaw);
    const manualImage = normalizeEdmImageUrl(manualRaw);
    const imageSource: EdmCandidate["image_source"] = priority.find((item) => item === "feed" ? Boolean(feedImage) : Boolean(manualImage)) ?? "none";
    const selectedImage = imageSource === "feed" ? feedImage : imageSource === "manual" ? manualImage : null;
    return {
      candidate: {
        sku: sku.sku,
        title: sku.title,
        category: sku.category ? normalized(sku.category) : null,
        tags: parseTags(tag?.tags),
        stock_status: stockFor(sku.sku, stockBySku),
        price: sku.price,
        compare_at_price: sku.compare_at_price,
        currency: sku.currency.trim() ? sku.currency.toUpperCase() : null,
        image_url: selectedImage,
        image_source: imageSource,
        priority: csvNumber(tag?.priority),
        last_featured: featuredByHandle.get(sku.handle) ?? null,
        exclude_edm: tag?.exclude_edm === "1",
        discount_tier: csvTier(tag?.discount_tier),
      },
      discountTierRaw: tag?.discount_tier ?? null,
      currencyMismatch: false,
      feedImageUrl: feedImage,
      manualImageUrl: manualImage,
      feedSourceUrl: normalizeEdmImageSourceUrl(feedRaw),
      manualSourceUrl: normalizeEdmImageSourceUrl(manualRaw),
      feedImagePresent: rawPresent(feedRaw),
      manualImagePresent: rawPresent(manualRaw),
    };
  }).sort((left, right) => compareKeys(left.candidate.sku, right.candidate.sku));
}

function aggregateParent(parentSku: string, children: readonly CandidateRow[], priority: readonly ("feed" | "manual")[]): CandidateRow | null {
  if (!children.length) return null;
  const rows = [...children].sort((left, right) => compareKeys(left.candidate.sku, right.candidate.sku));
  const candidates = rows.map((row) => row.candidate);
  const stockStatus = groupedStatus(candidates.map((row) => row.stock_status));
  const feedUrl = rows.flatMap((row) => row.feedImageUrl ? [row.feedImageUrl] : []).at(0) ?? null;
  const manualUrl = rows.flatMap((row) => row.manualImageUrl ? [row.manualImageUrl] : []).at(0) ?? null;
  const selectedSource = priority.find((source) => source === "feed" ? Boolean(feedUrl) : Boolean(manualUrl)) ?? "none";
  const selectedUrl = selectedSource === "feed" ? feedUrl : selectedSource === "manual" ? manualUrl : null;
  const categories = candidates.map((row) => row.category ?? "");
  const tags = [...new Set(candidates.flatMap((row) => row.tags))].sort(compareKeys);
  const currencies = [...new Set(candidates.flatMap((row) => row.currency ? [row.currency] : []))].sort(compareKeys);
  const featured = candidates.flatMap((row) => row.last_featured ? [row.last_featured] : []).sort(compareKeys).at(-1) ?? null;
  const tiers = [...new Set(candidates.flatMap((row) => row.discount_tier === null ? [] : [row.discount_tier]))].sort((a, b) => a - b);
  const rawTiers = rows.map((row) => row.discountTierRaw);
  const discountTierRaw = rawTiers.every((value) => value !== null) && tiers.length === 1
    ? String(tiers[0])
    : rawTiers.some((value) => value !== null) ? "<mixed>" : null;
  return {
    candidate: {
      sku: parentSku,
      title: candidates[0]!.title,
      category: commonCategory(categories),
      tags,
      stock_status: stockStatus,
      price: candidates.flatMap((row) => row.price === null ? [] : [row.price]).sort((a, b) => a - b)[0] ?? null,
      compare_at_price: candidates.flatMap((row) => row.compare_at_price === null ? [] : [row.compare_at_price]).sort((a, b) => a - b).at(-1) ?? null,
      currency: currencies.length === 1 ? currencies[0]! : null,
      image_url: selectedUrl,
      image_source: selectedSource,
      priority: candidates.flatMap((row) => row.priority === null ? [] : [row.priority]).sort((a, b) => b - a)[0] ?? null,
      last_featured: featured,
      exclude_edm: candidates.some((row) => row.exclude_edm),
      discount_tier: tiers.length === 1 ? tiers[0]! : null,
    },
    discountTierRaw,
    currencyMismatch: currencies.length > 1,
    feedImageUrl: feedUrl,
    manualImageUrl: manualUrl,
    feedSourceUrl: rows.flatMap((row) => row.feedSourceUrl ? [row.feedSourceUrl] : []).at(0) ?? null,
    manualSourceUrl: rows.flatMap((row) => row.manualSourceUrl ? [row.manualSourceUrl] : []).at(0) ?? null,
    feedImagePresent: rows.some((row) => row.feedImagePresent),
    manualImagePresent: rows.some((row) => row.manualImagePresent),
  };
}

function filteredCandidates(rows: readonly CandidateRow[], query: EdmCandidatesQuery): CandidateRow[] {
  return rows.filter(({ candidate }) => {
    if (query.stock !== "any" && candidate.stock_status !== "in_stock") return false;
    if (query.category && candidate.category !== normalized(query.category)) return false;
    if (query.tag && !candidate.tags.includes(normalized(query.tag))) return false;
    if (!query.include_excluded && candidate.exclude_edm) return false;
    return true;
  });
}

function sourceAnomalies(sources: EdmSources): ScenarioAnomaly[] {
  const anomalies: ScenarioAnomaly[] = [];
  if (sources.skus.state === "ok" && sources.skus.rows && sources.stock.state === "ok" && sources.stock.rows) {
    const stockSkus = new Set(sources.stock.rows.map((row) => row.sku));
    const missingStockCount = sources.skus.rows.filter((row) => row.status === "active" && !stockSkus.has(row.sku)).length;
    if (missingStockCount > 0) {
      anomalies.push(anomaly("SKU_STOCK_MISSING", "warning", `${missingStockCount} 个在售 SKU 缺少库存视图记录，按未知库存处理。`, "views.sku_stock.sku"));
    }
  }
  const stockCounts = new Map<string, number>();
  for (const row of sources.stock.rows ?? []) stockCounts.set(row.sku, (stockCounts.get(row.sku) ?? 0) + 1);
  if ([...stockCounts.values()].some((count) => count > 1)) {
    anomalies.push(anomaly("SKU_STOCK_DUPLICATE", "unreliable", "库存视图包含重复 SKU，重复项按未知库存处理。", "views.sku_stock.sku"));
  }
  return anomalies;
}

function invalidDateResult<T>(sources: EdmSources, field: string): ScenarioQueryResult<T> {
  return {
    data: null,
    metadata: metadata(sources, [anomaly("QUERY_DATE_INVALID", "unreliable", "活动日期不是有效的 ISO 日期。", field)]),
  };
}

function applyLimit<T>(rows: readonly T[], limit: number | undefined): T[] {
  return limit === undefined ? [...rows] : rows.slice(0, limit);
}

export async function readEdmCandidates(projectPath: string, query: EdmCandidatesQuery): Promise<ScenarioQueryResult<EdmCandidatesData>> {
  const sources = await readEdmSources(projectPath);
  const extras = sourceAnomalies(sources);
  const rows = candidateRows(sources, Boolean(query.parent_only), extras);
  if (!rows) return { data: null, metadata: metadata(sources, extras) };
  const filtered = filteredCandidates(rows, query);
  const total = filtered.length;
  const limit = query.limit === undefined ? undefined : Math.max(0, Math.floor(query.limit));
  return {
    data: { rows: applyLimit(filtered, limit).map((row) => row.candidate), total },
    metadata: metadata(sources, extras),
  };
}

export async function readEdmMediaGaps(projectPath: string, query: EdmMediaGapsQuery): Promise<ScenarioQueryResult<EdmMediaGapsData>> {
  const sources = await readEdmSources(projectPath);
  const extras = sourceAnomalies(sources);
  const rows = candidateRows(sources, Boolean(query.parent_only), extras);
  if (!rows) return { data: null, metadata: metadata(sources, extras) };
  const bySku = new Map(rows.map((row) => [row.candidate.sku, row]));
  const gaps = rows.filter((row) => row.candidate.image_url === null)
    .map(({ candidate, feedImagePresent, manualImagePresent }): EdmMediaGap => ({
      sku: candidate.sku,
      title: candidate.title,
      stock_status: candidate.stock_status,
      reason: feedImagePresent || manualImagePresent ? "webp_only" : "missing",
      feed_image_url: null,
      manual_image_url: null,
    }));
  const filtered = gaps.filter((gap) => (query.stock === "any" || gap.stock_status === "in_stock")
    && (!query.skus || query.skus.includes(gap.sku)))
    .map((gap) => {
      const row = bySku.get(gap.sku);
      return { ...gap, feed_image_url: row?.feedSourceUrl ?? null, manual_image_url: row?.manualSourceUrl ?? null };
    });
  const total = filtered.length;
  return { data: { rows: applyLimit(filtered, query.limit), total }, metadata: metadata(sources, extras) };
}

function dateDistance(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function finding(code: EdmCampaignSafetyFinding["code"], severity: EdmCampaignSafetyFinding["severity"], sku: string | undefined, message: string, field?: string): EdmCampaignSafetyFinding {
  return { code, severity, ...(sku ? { sku } : {}), ...(field ? { field } : {}), message };
}

export async function readEdmCampaignSafety(projectPath: string, query: EdmCampaignSafetyQuery): Promise<ScenarioQueryResult<EdmCampaignSafetyData>> {
  const sources = await readEdmSources(projectPath);
  if (!date(query.campaign_date)) return invalidDateResult<EdmCampaignSafetyData>(sources, "campaign_date");
  const extras = sourceAnomalies(sources);
  const realRows = candidateRows(sources, false, extras, query.campaign_date);
  const parentRows = candidateRows(sources, true, extras, query.campaign_date);
  const bySku = new Map([...(realRows ?? []), ...(parentRows ?? [])].map((row) => [row.candidate.sku, row]));
  const selected = [...new Set(query.skus)].sort(compareKeys);
  const findings: EdmCampaignSafetyFinding[] = [];
  const selectionCounts = new Map<string, number>();
  for (const sku of query.skus) selectionCounts.set(sku, (selectionCounts.get(sku) ?? 0) + 1);
  for (const [sku, count] of [...selectionCounts].sort(([left], [right]) => compareKeys(left, right))) {
    if (count > 1) findings.push(finding("duplicate_sku", "blocker", sku, "SKU 在本次选择中重复。", "skus"));
  }
  const site = sources.site.rows;
  const tiers = site?.discountTiers ?? null;
  for (const sku of selected) {
    const row = bySku.get(sku);
    if (!row && realRows !== null && parentRows !== null) {
      findings.push(finding("sku_not_found", "blocker", sku, "SKU 不存在于当前索引的在售目录。", "catalog.skus"));
      continue;
    }
    if (!row) continue;
    const item = row.candidate;
    if (item.stock_status === "out_of_stock") findings.push(finding("out_of_stock", "blocker", sku, "商品当前缺货。", "views.sku_stock.stock_status"));
    else if (item.stock_status !== "in_stock") extras.push(anomaly("STOCK_STATUS_REVIEW", "warning", "商品库存为预售或未知，活动安全检查需要人工确认。", `views.sku_stock.${sku}`));
    if (item.exclude_edm) findings.push(finding("excluded_from_edm", "blocker", sku, "商品已标记为不参加 EDM。", "ledgers.sku_tags.exclude_edm"));
    if (!item.image_url) findings.push(finding(row.feedImagePresent || row.manualImagePresent ? "webp_only" : "missing_image", "blocker", sku,
      row.feedImagePresent || row.manualImagePresent ? "已有图片来源，但没有兼容的 EDM 图片格式。" : "商品没有已索引的图片来源。", "image_url"));
    if (row.discountTierRaw === "<mixed>" || row.discountTierRaw !== null && (item.discount_tier === null
      || sources.site.state === "ok" && (tiers === null || !tiers.includes(item.discount_tier)))) {
      findings.push(finding("discount_tier_invalid", "warning", sku, "折扣档位不在项目配置的可用档位中。", "ledgers.sku_tags.discount_tier"));
    }
    if (item.last_featured && dateDistance(item.last_featured, query.campaign_date) >= 0
      && dateDistance(item.last_featured, query.campaign_date) < (site?.cooldownDays ?? 21)) {
      findings.push(finding("cooldown_active", "warning", sku, "商品仍处于 EDM 冷却期。", "last_featured"));
    }
    if (site?.currency && (row.currencyMismatch || item.currency !== null && item.currency !== site.currency)) {
      findings.push(finding("currency_mismatch", "blocker", sku, "商品币种与项目币种不一致。", "currency"));
    }
    if (site?.currency && !item.currency) extras.push(anomaly("SKU_CURRENCY_UNKNOWN", "warning", "商品币种缺失，无法与项目币种核对。", `catalog.skus.${sku}.currency`));
  }
  findings.sort((left, right) => compareKeys(left.code, right.code)
    || compareKeys(left.sku ?? "", right.sku ?? "") || compareKeys(left.field ?? "", right.field ?? ""));
  const queryFindings = [...new Map(findings.map((item) => [`${item.code}\u0000${item.sku ?? ""}\u0000${item.field ?? ""}`, item])).values()];
  const resultMetadata = metadata(sources, extras);
  const status: EdmCampaignSafetyData["status"] = queryFindings.some((item) => item.severity === "blocker") ? "blocked"
    : queryFindings.some((item) => item.severity === "warning") || resultMetadata.quality !== "complete" ? "needs_review" : "clear";
  return {
    data: { scope: "local_product_data", status, checked_skus: selected, findings: queryFindings },
    metadata: resultMetadata,
  };
}
