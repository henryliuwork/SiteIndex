import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  InventoryEvent,
  ProductChanges,
  ProductGroupFamily,
  ProductSkuBrief,
  RunLog,
  ScenarioAnomaly,
  ScenarioQueryResult,
  ScenarioResultMetadata,
  ScenarioSource,
  SkuGroupingRule,
  SkuRecord,
  SkuStockView,
} from "@siteindex/shared";
import { JOB_NAMES } from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { parseJsonl, type JsonRecord } from "../io/jsonl";
import { pathsForProject } from "../io/project-layout";
import { groupSkuIds, SkuGroupingRuleError } from "../inventory/sku-grouping";

type SourceState = "ok" | "missing" | "invalid" | "unreadable";

interface SourceRows<T> {
  field: string;
  source: ScenarioSource;
  state: SourceState;
  rows: T[] | null;
}

interface MetadataExtras {
  missingFields?: readonly string[];
  anomalies?: readonly ScenarioAnomaly[];
}

interface DailyCollection {
  collectedAt: string | null;
  missingFields: string[];
  anomalies: ScenarioAnomaly[];
}

interface GroupingConfig extends SourceRows<SkuGroupingRule> {
  mode: "enabled" | "disabled" | "unconfigured";
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const STOCK_STATUSES = new Set(["in_stock", "out_of_stock", "preorder", "unknown"]);
const EVENT_TYPES = new Set(["stock_change", "price_change", "new_sku", "removed_sku", "restored_sku", "feed_anomaly"]);
const JOB_NAME_SET = new Set<string>(JOB_NAMES);

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string"
    && DATE_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSkuRecord(row: JsonRecord): row is JsonRecord & SkuRecord {
  return typeof row.sku === "string"
    && typeof row.product_id === "string"
    && typeof row.handle === "string"
    && typeof row.title === "string"
    && isNullableString(row.variant_title)
    && typeof row.url === "string"
    && typeof row.category === "string"
    && (row.category_source === "url_rule" || row.category_source === "feed" || row.category_source === "manual" || row.category_source === "none")
    && typeof row.price === "number" && Number.isFinite(row.price)
    && (row.compare_at_price === null || (typeof row.compare_at_price === "number" && Number.isFinite(row.compare_at_price)))
    && typeof row.currency === "string"
    && isNullableString(row.image_url)
    && (row.status === "active" || row.status === "removed")
    && validDate(row.first_seen)
    && validDate(row.last_seen)
    && validDate(row.updated_at)
    && (!Object.hasOwn(row, "categories") || isStringArray(row.categories))
    && (!Object.hasOwn(row, "additional_images") || isStringArray(row.additional_images))
    && (!Object.hasOwn(row, "gtin") || isNullableString(row.gtin))
    && (!Object.hasOwn(row, "mpn") || isNullableString(row.mpn))
    && (!Object.hasOwn(row, "brand") || isNullableString(row.brand))
    && (!Object.hasOwn(row, "removed_reason") || row.removed_reason === "feed_absent_404" || row.removed_reason === "feed_absent_aged");
}

function isSkuStockView(row: JsonRecord): row is JsonRecord & SkuStockView {
  return typeof row.sku === "string"
    && typeof row.title === "string"
    && isNullableString(row.variant_title)
    && typeof row.category === "string"
    && typeof row.price === "number" && Number.isFinite(row.price)
    && typeof row.stock_status === "string" && STOCK_STATUSES.has(row.stock_status)
    && validDate(row.since)
    && typeof row.days_in_status === "number" && Number.isFinite(row.days_in_status)
    && (row.online_rate_7d === null || (typeof row.online_rate_7d === "number" && Number.isFinite(row.online_rate_7d)))
    && (row.online_rate_30d === null || (typeof row.online_rate_30d === "number" && Number.isFinite(row.online_rate_30d)))
    && typeof row.history_30d === "string"
    && typeof row.changes_30d === "number" && Number.isFinite(row.changes_30d)
    && isNullableString(row.last_change)
    && (row.last_change_at === null || validDate(row.last_change_at))
    && (!Object.hasOwn(row, "parent_sku") || isNullableString(row.parent_sku))
    && (!Object.hasOwn(row, "is_parent") || typeof row.is_parent === "boolean")
    && (!Object.hasOwn(row, "children_count") || (typeof row.children_count === "number" && Number.isFinite(row.children_count)))
    && (!Object.hasOwn(row, "in_stock_children_count") || (typeof row.in_stock_children_count === "number" && Number.isFinite(row.in_stock_children_count)))
    && (!Object.hasOwn(row, "price_history") || (Array.isArray(row.price_history) && row.price_history.every((entry) =>
      isObject(entry) && validDate(entry.date) && typeof entry.price === "number" && Number.isFinite(entry.price))));
}

function isInventoryEvent(row: JsonRecord): row is JsonRecord & InventoryEvent {
  return validDate(row.date)
    && typeof row.sku === "string"
    && typeof row.type === "string" && EVENT_TYPES.has(row.type)
    && Object.hasOwn(row, "from")
    && Object.hasOwn(row, "to")
    && typeof row.category === "string"
    && typeof row.title === "string";
}

function isRunLog(row: JsonRecord): row is JsonRecord & RunLog {
  return typeof row.run_id === "string"
    && typeof row.job === "string" && JOB_NAME_SET.has(row.job)
    && validTimestamp(row.started_at)
    && (row.finished_at === null || validTimestamp(row.finished_at))
    && (row.status === "ok" || row.status === "partial" || row.status === "failed" || row.status === "skipped");
}

function source(field: string, label: string): ScenarioSource {
  return { kind: field, label };
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readJsonlSource<T extends object>(
  projectPath: string,
  relativePath: string,
  field: string,
  label: string,
  validate: (row: JsonRecord) => row is JsonRecord & T,
): Promise<SourceRows<T>> {
  const filePath = path.join(projectPath, relativePath);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = errorCode(error);
    return {
      field,
      source: source(field, label),
      state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      rows: null,
    };
  }

  let parsed: JsonRecord[];
  try {
    parsed = parseJsonl(text, label);
  } catch {
    return { field, source: source(field, label), state: "invalid", rows: null };
  }
  const rows = parsed.filter(validate);
  if (rows.length !== parsed.length) return { field, source: source(field, label), state: "invalid", rows: null };
  return { field, source: source(field, label), state: "ok", rows };
}

async function readEventSource(projectPath: string, relativeDirectory: string): Promise<SourceRows<InventoryEvent>> {
  const field = "inventory.events";
  const label = "库存变化事件";
  const directory = path.join(projectPath, relativeDirectory);
  let files: string[];
  try {
    files = (await readdir(directory)).filter((name) => /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/u.test(name)).sort(compareKeys);
  } catch (error) {
    const code = errorCode(error);
    return {
      field,
      source: source(field, label),
      state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      rows: null,
    };
  }

  const rows: InventoryEvent[] = [];
  for (const name of files) {
    let text: string;
    try {
      text = await readFile(path.join(directory, name), "utf8");
    } catch (error) {
      const code = errorCode(error);
      return {
        field,
        source: source(field, label),
        state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
        rows: null,
      };
    }
    let parsed: JsonRecord[];
    try {
      parsed = parseJsonl(text, `${relativeDirectory}/${name}`);
    } catch {
      return { field, source: source(field, label), state: "invalid", rows: null };
    }
    const validRows = parsed.filter(isInventoryEvent);
    if (validRows.length !== parsed.length) return { field, source: source(field, label), state: "invalid", rows: null };
    rows.push(...validRows);
  }
  return { field, source: source(field, label), state: "ok", rows };
}

async function readGroupingConfig(projectPath: string, relativePath: string): Promise<GroupingConfig> {
  const field = "site.sku_grouping";
  const label = "项目 SKU 分组配置";
  let text: string;
  try {
    text = await readFile(path.join(projectPath, relativePath), "utf8");
  } catch (error) {
    const code = errorCode(error);
    return {
      field,
      source: source(field, label),
      state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      rows: null,
      mode: "unconfigured",
    };
  }

  let config: JsonRecord;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error("项目配置必须是 JSON 对象。");
    config = parsed;
  } catch {
    return { field, source: source(field, label), state: "invalid", rows: null, mode: "unconfigured" };
  }

  const rawGrouping = config.sku_grouping;
  if (rawGrouping === undefined) return { field, source: source(field, label), state: "ok", rows: [], mode: "unconfigured" };
  if (!isObject(rawGrouping) || typeof rawGrouping.enabled !== "boolean") {
    return { field, source: source(field, label), state: "invalid", rows: null, mode: "unconfigured" };
  }
  if (!rawGrouping.enabled) return { field, source: source(field, label), state: "ok", rows: [], mode: "disabled" };

  const rule = rawGrouping.rule;
  if (!isObject(rule)
    || (rule.type !== "suffix" && rule.type !== "separator" && rule.type !== "regex")
    || typeof rule.value !== "string"
    || !rule.value.trim()) {
    return { field, source: source(field, label), state: "invalid", rows: null, mode: "enabled" };
  }
  return {
    field,
    source: source(field, label),
    state: "ok",
    rows: [{ type: rule.type, value: rule.value }],
    mode: "enabled",
  };
}

function anomaly(code: string, severity: ScenarioAnomaly["severity"], message: string, field?: string): ScenarioAnomaly {
  return { code, severity, message, ...(field ? { field } : {}) };
}

function dailyCollection(runs: SourceRows<RunLog>): DailyCollection {
  if (runs.state !== "ok" || !runs.rows) return { collectedAt: null, missingFields: [], anomalies: [] };
  const daily = runs.rows.filter((run) => run.job === "daily");
  if (!daily.length) {
    return {
      collectedAt: null,
      missingFields: ["logs.runs.daily_success"],
      anomalies: [anomaly("DAILY_RUN_MISSING", "warning", "没有 daily 运行记录，无法确认商品数据采集时间。", "logs.runs")],
    };
  }
  const sorted = [...daily].sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at)
    || compareKeys(right.started_at, left.started_at));
  const latestAttempt = sorted[0]!;
  const anomalies: ScenarioAnomaly[] = [];
  if (latestAttempt.status !== "ok") {
    anomalies.push(anomaly("DAILY_LATEST_NOT_SUCCESSFUL", "warning", "最近一次 daily 未完整成功，商品索引可能未全部更新。", "logs.runs"));
  }
  if (daily.some((run) => run.status === "ok" && !validTimestamp(run.finished_at))) {
    anomalies.push(anomaly("DAILY_TIMESTAMP_INVALID", "warning", "daily 成功记录缺少有效完成时间。", "logs.runs"));
  }
  const successful = sorted.filter((run) => run.status === "ok" && validTimestamp(run.finished_at))
    .sort((left, right) => Date.parse(right.finished_at!) - Date.parse(left.finished_at!)
      || compareKeys(right.started_at, left.started_at));
  if (!successful.length) {
    return {
      collectedAt: null,
      missingFields: ["logs.runs.daily_success"],
      anomalies: [...anomalies, anomaly("DAILY_COLLECTION_UNKNOWN", "warning", "没有成功完成的 daily 运行记录，无法确认商品数据采集时间。", "logs.runs")],
    };
  }
  return { collectedAt: successful[0]!.finished_at, missingFields: [], anomalies };
}

function metadata(
  sources: readonly SourceRows<unknown>[],
  collection: DailyCollection,
  extras: MetadataExtras = {},
): ScenarioResultMetadata {
  const missing = new Set([...collection.missingFields, ...(extras.missingFields ?? [])]);
  const anomalies: ScenarioAnomaly[] = [...collection.anomalies, ...(extras.anomalies ?? [])];
  for (const item of sources) {
    if (item.state === "ok") continue;
    missing.add(item.field);
    if (item.state === "missing") anomalies.push(anomaly("SOURCE_MISSING", "warning", `${item.source.label ?? item.field}文件不存在。`, item.field));
    else if (item.state === "invalid") anomalies.push(anomaly("SOURCE_INVALID", "unreliable", `${item.source.label ?? item.field}包含无效记录，无法安全读取。`, item.field));
    else anomalies.push(anomaly("SOURCE_UNREADABLE", "unreliable", `${item.source.label ?? item.field}无法读取。`, item.field));
  }
  const uniqueAnomalies = new Map<string, ScenarioAnomaly>();
  for (const item of anomalies) uniqueAnomalies.set(`${item.code}\u0000${item.field ?? ""}\u0000${item.message}`, item);
  const sortedAnomalies = [...uniqueAnomalies.values()].sort((left, right) =>
    compareKeys(left.code, right.code) || compareKeys(left.field ?? "", right.field ?? "") || compareKeys(left.message, right.message));
  const missingFields = [...missing].sort(compareKeys);
  const sourceByKind = new Map(sources.map((item) => [item.source.kind, item.source]));
  const orderedSources = [...sourceByKind.values()].sort((left, right) => compareKeys(left.kind, right.kind));
  const quality = sortedAnomalies.some((item) => item.severity === "unreliable")
    ? "unreliable"
    : sortedAnomalies.length || missingFields.length ? "partial" : "complete";
  return {
    sources: orderedSources,
    collected_at: collection.collectedAt,
    missing_fields: missingFields,
    quality,
    anomalies: sortedAnomalies,
  };
}

function result<T>(data: T | null, sources: readonly SourceRows<unknown>[], collection: DailyCollection, extras?: MetadataExtras): ScenarioQueryResult<T> {
  return { data, metadata: metadata(sources, collection, extras) };
}

function compareEvent(left: InventoryEvent, right: InventoryEvent): number {
  return compareKeys(left.date, right.date)
    || compareKeys(left.sku, right.sku)
    || compareKeys(left.type, right.type)
    || compareKeys(left.category, right.category)
    || compareKeys(left.title, right.title)
    || compareKeys(stableValue(left.from), stableValue(right.from))
    || compareKeys(stableValue(left.to), stableValue(right.to));
}

function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort(compareKeys).map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return "";
}

function findSku(rows: readonly SkuRecord[], sku: string): { row: SkuRecord | null; anomaly?: ScenarioAnomaly; missingField?: string } {
  const matches = rows.filter((row) => row.sku === sku);
  if (matches.length > 1) return {
    row: null,
    anomaly: anomaly("SKU_RECORD_DUPLICATE", "unreliable", "SKU 目录包含重复记录，无法确定唯一商品资料。", "catalog.skus.sku"),
  };
  if (!matches.length) return {
    row: null,
    missingField: "catalog.skus.sku",
    anomaly: anomaly("SKU_NOT_INDEXED", "warning", "该 SKU 尚无已抓取的目录记录。", "catalog.skus.sku"),
  };
  return { row: matches[0]! };
}

function runCollectionExtras(collection: DailyCollection): MetadataExtras {
  return { missingFields: collection.missingFields, anomalies: collection.anomalies };
}

export async function readProductSkuBrief(projectPath: string, sku: string): Promise<ScenarioQueryResult<ProductSkuBrief>> {
  const paths = await pathsForProject(projectPath);
  const [skus, stock, runs] = await Promise.all([
    readJsonlSource(projectPath, paths.skus, "catalog.skus", "商品 SKU 目录", isSkuRecord),
    readJsonlSource(projectPath, paths.skuStockView, "views.sku_stock", "SKU 库存视图", isSkuStockView),
    readJsonlSource(projectPath, paths.runs, "logs.runs", "Job 运行记录", isRunLog),
  ]);
  const sources = [skus, stock, runs];
  const collection = dailyCollection(runs);
  if (skus.state !== "ok" || !skus.rows) return result<ProductSkuBrief>(null, sources, collection);
  const found = findSku(skus.rows, sku);
  if (!found.row) return result<ProductSkuBrief>(null, sources, collection, {
    ...(found.missingField ? { missingFields: [found.missingField] } : {}),
    ...(found.anomaly ? { anomalies: [found.anomaly] } : {}),
  });

  if (stock.state !== "ok" || !stock.rows) return result({ sku: found.row, stock: null }, sources, collection);
  const stockMatches = stock.rows.filter((row) => row.sku === sku);
  if (stockMatches.length > 1) return result({ sku: found.row, stock: null }, sources, collection, {
    anomalies: [anomaly("SKU_STOCK_DUPLICATE", "unreliable", "SKU 库存视图包含重复记录，未返回库存摘要。", "views.sku_stock.sku")],
  });
  if (!stockMatches.length && found.row.status === "active") return result({ sku: found.row, stock: null }, sources, collection, {
    missingFields: ["views.sku_stock.sku"],
    anomalies: [anomaly("SKU_STOCK_NOT_INDEXED", "warning", "在售 SKU 尚无库存视图记录。", "views.sku_stock.sku")],
  });
  return result({ sku: found.row, stock: stockMatches[0] ?? null }, sources, collection);
}

export async function readProductChanges(projectPath: string, sku?: string): Promise<ScenarioQueryResult<ProductChanges>> {
  const paths = await pathsForProject(projectPath);
  const [events, runs] = await Promise.all([
    readEventSource(projectPath, paths.eventsDir),
    readJsonlSource(projectPath, paths.runs, "logs.runs", "Job 运行记录", isRunLog),
  ]);
  const collection = dailyCollection(runs);
  const data = events.state === "ok" && events.rows
    ? events.rows.filter((event) => sku === undefined || event.sku === sku).sort(compareEvent)
    : null;
  return result(data, [events, runs], collection);
}

function emptyFamily(sku: string): ProductGroupFamily {
  return { sku, role: "single", parent_sku: null, child_skus: [], collision: null };
}

export async function readProductGroupFamily(projectPath: string, sku: string): Promise<ScenarioQueryResult<ProductGroupFamily>> {
  const paths = await pathsForProject(projectPath);
  const [skus, grouping, runs] = await Promise.all([
    readJsonlSource(projectPath, paths.skus, "catalog.skus", "商品 SKU 目录", isSkuRecord),
    readGroupingConfig(projectPath, paths.site),
    readJsonlSource(projectPath, paths.runs, "logs.runs", "Job 运行记录", isRunLog),
  ]);
  const sources = [skus, grouping, runs];
  const collection = dailyCollection(runs);
  if (skus.state !== "ok" || !skus.rows || grouping.state !== "ok" || !grouping.rows) {
    return result<ProductGroupFamily>(null, sources, collection);
  }

  const found = findSku(skus.rows, sku);
  if (!found.row) return result<ProductGroupFamily>(null, sources, collection, {
    ...(found.missingField ? { missingFields: [found.missingField] } : {}),
    ...(found.anomaly ? { anomalies: [found.anomaly] } : {}),
  });
  if (found.row.status !== "active") return result<ProductGroupFamily>(null, sources, collection, {
    missingFields: ["catalog.skus.active_sku"],
    anomalies: [anomaly("SKU_NOT_ACTIVE", "warning", "该 SKU 已不在当前 active feed 中，无法确认现行分组关系。", "catalog.skus.active_sku")],
  });

  if (grouping.mode === "unconfigured") return result(emptyFamily(sku), sources, collection, {
    anomalies: [anomaly("SKU_GROUPING_NOT_CONFIGURED", "warning", "项目未配置 SKU 分组规则；当前 SKU 按独立商品处理。", "site.sku_grouping")],
  });
  if (grouping.mode === "disabled") return result(emptyFamily(sku), sources, collection, {
    anomalies: [anomaly("SKU_GROUPING_DISABLED", "warning", "项目已关闭 SKU 分组；当前 SKU 按独立商品处理。", "site.sku_grouping")],
  });

  let groupingResult;
  try {
    groupingResult = groupSkuIds(skus.rows.filter((row) => row.status === "active").map((row) => row.sku), grouping.rows[0]!);
  } catch (error) {
    if (!(error instanceof SkuGroupingRuleError)) throw error;
    return result<ProductGroupFamily>(null, sources, collection, {
      anomalies: [anomaly("SKU_GROUPING_RULE_INVALID", "unreliable", "项目 SKU 分组规则无效，无法生成家族关系。", "site.sku_grouping.rule")],
    });
  }

  const normalParent = groupingResult.groups.find((group) => group.parent === sku);
  const normalChild = groupingResult.groups.find((group) => group.children.includes(sku));
  const collisions = groupingResult.collisions.filter((group) => group.parent === sku || group.children.includes(sku));
  if (collisions.length > 1 || (collisions.length > 0 && (normalChild || normalParent))) return result<ProductGroupFamily>(null, sources, collection, {
    anomalies: [anomaly("SKU_FAMILY_AMBIGUOUS", "unreliable", "该 SKU 同时命中多个分组关系，无法用单一家族结果准确表达。", "site.sku_grouping")],
  });
  const collision = collisions[0] ?? null;
  if (normalChild) return result({
    sku,
    role: "child",
    parent_sku: normalChild.parent,
    child_skus: [...normalChild.children],
    collision,
  }, sources, collection);
  if (normalParent) return result({
    sku,
    role: "parent",
    parent_sku: normalParent.parent,
    child_skus: [...normalParent.children],
    collision,
  }, sources, collection);
  if (collision) return result({
    sku,
    role: "collision",
    parent_sku: collision.parent,
    child_skus: [...collision.children],
    collision,
  }, sources, collection);
  return result(emptyFamily(sku), sources, collection);
}
