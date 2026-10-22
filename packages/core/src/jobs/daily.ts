import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { CSV_HEADERS, EXIT, PATHS, dailyReportFile, eventsFile, type CategoryMode } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";
import { readCsv, writeCsv } from "../io/csv";
import { readJsonl, writeJsonl, type JsonRecord } from "../io/jsonl";

type StockStatus = "in_stock" | "out_of_stock" | "preorder" | "unknown";
type EventType = "stock_change" | "price_change" | "new_sku" | "removed_sku" | "restored_sku";
type DailyStatus = "ok" | "partial" | "failed";
type StockCounts = Record<"total" | StockStatus, number>;

interface CategoryMatch { type: "product_type_contains" | "sku_prefix" | "url_contains" | "skus"; value: string }
interface ManualCategory { slug: string; match?: CategoryMatch[] }
interface DailySite {
  domain: string;
  timezone?: string;
  schema_version?: string;
  crawl?: {
    missing_as?: "out_of_stock" | "removed";
    missing_removed_after_days?: number;
    max_removed_ratio?: number;
    overrides?: Record<string, Record<string, unknown>>;
  };
  categories?: { mode: CategoryMode; url_pattern?: string; manual?: ManualCategory[] };
}
export type DailySnapshot = JsonRecord & { sku: string };
export interface DailyOptions {
  date?: string;
  now?: Date | (() => Date);
  maxRemovedRatio?: number;
  force?: boolean;
}
export interface DailyResult {
  exitCode: number;
  status: DailyStatus;
  counts: Record<string, number>;
  errors: string[];
}

const STOCK_STATES: readonly StockStatus[] = ["in_stock", "out_of_stock", "preorder", "unknown"];
const TRACKED = ["product_id", "handle", "title", "variant_title", "url", "category", "categories", "category_source",
  "price", "compare_at_price", "currency", "image_url"] as const;

function nowDate(now: DailyOptions["now"]): Date {
  return now instanceof Date ? new Date(now) : typeof now === "function" ? now() : new Date();
}

function dateParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

function isoInZone(date: Date, timezone = "UTC"): string {
  const parts = dateParts(date, timezone);
  const suffix = parts.timeZoneName === "GMT" ? "+00:00" : (parts.timeZoneName ?? "GMT+00:00").replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${suffix}`;
}

function dayInZone(date: Date, timezone = "UTC"): string {
  const parts = dateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isStockStatus(value: unknown): value is StockStatus {
  return typeof value === "string" && (STOCK_STATES as readonly string[]).includes(value);
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll("&", " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "uncategorized";
}

function categoryFor(site: DailySite, sku: string, snapshot: DailySnapshot): { category: string; categories: string[]; source?: string } {
  const config = site.categories;
  if (!config) return {
    category: String(snapshot.category || "uncategorized"),
    categories: Array.isArray(snapshot.categories) && snapshot.categories.length ? snapshot.categories.map(String) : [String(snapshot.category || "uncategorized")],
  };
  if (config.mode === "feed") {
    const category = String(snapshot.category || "uncategorized");
    return { category, categories: Array.isArray(snapshot.categories) && snapshot.categories.length ? snapshot.categories.map(String) : [category], source: "feed" };
  }
  if (config.mode === "url_rule") {
    const pathname = typeof snapshot.url === "string" ? new URL(snapshot.url).pathname : "";
    for (const rawPattern of (config.url_pattern ?? "").split(",")) {
      const pattern = rawPattern.trim();
      if (!pattern) continue;
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{slug\\\}/g, "([^/]+)");
      const match = new RegExp(`^${escaped}(?:/|$)`, "i").exec(pathname);
      if (match?.[1]) {
        let category = match[1];
        try { category = decodeURIComponent(category); } catch { /* malformed path segment stays encoded */ }
        const slug = slugify(category);
        return { category: slug, categories: [slug], source: "url_rule" };
      }
    }
    return { category: "uncategorized", categories: ["uncategorized"], source: "none" };
  }
  if (config.mode === "manual") {
    for (const category of config.manual ?? []) {
      if ((category.match ?? []).some((match) => matchesManualRule(match, sku, snapshot))) {
        return { category: category.slug, categories: [category.slug], source: "manual" };
      }
    }
    return { category: "uncategorized", categories: ["uncategorized"], source: "none" };
  }
  const feedCategory = String(snapshot.category || "uncategorized");
  return { category: feedCategory, categories: [feedCategory], source: "none" };
}

function matchesManualRule(rule: CategoryMatch, sku: string, snapshot: DailySnapshot): boolean {
  const needle = rule.value.trim().toLowerCase();
  if (!needle) return false;
  if (rule.type === "sku_prefix") return sku.toLowerCase().startsWith(needle);
  if (rule.type === "skus") return rule.value.split(/[,;|]/).some((value) => value.trim() === sku);
  if (rule.type === "url_contains") return String(snapshot.url ?? "").toLowerCase().includes(needle);
  const source = [snapshot.product_type, snapshot.category, ...(Array.isArray(snapshot.categories) ? snapshot.categories : [])]
    .filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
  return source.includes(needle) || source.includes(slugify(rule.value));
}

function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function eventLabel(row: JsonRecord): string {
  const title = String(row.title || row.sku || "");
  return row.variant_title ? `${title} / ${String(row.variant_title)}` : title;
}

function formatReportValue(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) ? `${value}.0` : String(value);
}

function roundHalfEven(value: number, digits: number): string {
  const scale = 10 ** digits;
  const scaled = value * 100 * scale;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  let rounded: number;
  if (Math.abs(fraction - 0.5) < 1e-10) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  return (rounded / scale).toFixed(digits);
}

function renderReport(
  site: DailySite,
  day: string,
  agg: Map<string, StockCounts>,
  prev: Map<string, CsvRow>,
  events: JsonRecord[],
  skus: Map<string, JsonRecord>,
  latest: Map<string, JsonRecord>,
): string {
  const by = new Map<string, JsonRecord[]>();
  for (const event of events) {
    const key = event.type === "stock_change" ? `stock:${String(event.to)}` : String(event.type);
    const list = by.get(key) ?? [];
    list.push(event);
    by.set(key, list);
  }
  const all = agg.get("_all") ?? emptyCounts();
  const rate = all.total ? all.in_stock / all.total : 0;
  const lines = [
    `# ${site.domain} 库存日报 · ${day}`, "",
    `- 在售 SKU：**${all.total}**，有货 ${all.in_stock}（${roundHalfEven(rate, 1)}%），缺货 ${all.out_of_stock}，预售 ${all.preorder}，未知 ${all.unknown}`,
    `- 新到货 **${(by.get("stock:in_stock") ?? []).length}**｜新缺货 **${(by.get("stock:out_of_stock") ?? []).length}**｜调价 ${(by.get("price_change") ?? []).length}｜上新 ${(by.get("new_sku") ?? []).length}｜下架 ${(by.get("removed_sku") ?? []).length}`, "",
  ];

  const section = (title: string, key: string, format: (event: JsonRecord) => string) => {
    const items = by.get(key) ?? [];
    if (!items.length) return;
    lines.push(`## ${title}（${items.length}）`, "");
    items.sort((a, b) => compareKeys(String(a.category ?? ""), String(b.category ?? "")) || compareKeys(String(a.title ?? ""), String(b.title ?? "")));
    for (const event of items) lines.push(`- \`${String(event.sku)}\` ${String(event.title)} · ${String(event.category)}${format(event)}`);
    lines.push("");
  };

  section("新到货", "stock:in_stock", (event) => `（原 ${String(event.from)}）`);
  section("新缺货", "stock:out_of_stock", () => "");
  section("转预售", "stock:preorder", () => "");
  section("状态未知", "stock:unknown", (event) => `（原 ${String(event.from)}）`);
  section("调价", "price_change", (event) => `：${formatReportValue(event.from)} → ${formatReportValue(event.to)}`);
  section("上新", "new_sku", (event) => `：${formatReportValue(event.to)}`);
  section("下架/消失", "removed_sku", () => "");

  lines.push("## 分类概览", "", "| 分类 | 在售 | 有货 | 缺货 | 有货率 | 较前日缺货 |", "|---|---:|---:|---:|---:|---:|");
  for (const category of [...agg.keys()].filter((key) => key !== "_all").sort(compareKeys)) {
    const counts = agg.get(category)!;
    const previous = prev.get(category);
    const delta = previous ? counts.out_of_stock - Number.parseInt(String(previous.out_of_stock ?? "0"), 10) : null;
    const deltaText = delta === null ? "—" : delta > 0 ? `+${delta}` : String(delta);
    const percentage = counts.total ? roundHalfEven(counts.in_stock / counts.total, 0) : "0";
    lines.push(`| ${category} | ${counts.total} | ${counts.in_stock} | ${counts.out_of_stock} | ${percentage}% | ${deltaText} |`);
  }
  lines.push("");

  const longOutOfStock = [...latest.entries()]
    .filter(([sku, row]) => row.stock_status === "out_of_stock" && skus.get(sku)?.status === "active")
    .map(([sku, row]) => [String(row.since ?? ""), sku] as const)
    .sort((a, b) => compareKeys(a[0], b[0]) || compareKeys(a[1], b[1])).slice(0, 15);
  if (longOutOfStock.length) {
    lines.push("## 缺货时间最长（前 15）", "");
    for (const [since, sku] of longOutOfStock) lines.push(`- \`${sku}\` ${eventLabel(skus.get(sku)!)} · 自 ${since}`);
    lines.push("");
  }
  return lines.join("\n");
}

type CsvRow = Record<string, string | null>;
function emptyCounts(): StockCounts { return { total: 0, in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 }; }
function addCounts(map: Map<string, StockCounts>, category: string, status: StockStatus): void {
  const counts = map.get(category) ?? emptyCounts();
  counts.total += 1;
  counts[status] += 1;
  map.set(category, counts);
}
async function appendRun(project: string, record: JsonRecord): Promise<void> {
  const pathToRuns = path.join(project, PATHS.runs);
  const rows = await readJsonl(pathToRuns);
  const next = rows.filter((row) => row.run_id !== record.run_id);
  next.push(record);
  await writeJsonl(pathToRuns, next, "run_log");
}

/** 合并一份解析后的 feed 快照，输出每日 SKU、库存、事件、汇总、日报与 runs。 */
export async function runDaily(project: string, snapshot: readonly DailySnapshot[], options: DailyOptions = {}): Promise<DailyResult> {
  const sitePath = path.join(project, PATHS.site);
  const site = JSON.parse(await readFile(sitePath, "utf8")) as DailySite;
  const now = nowDate(options.now);
  const timezone = site.timezone ?? "UTC";
  const day = options.date ?? dayInZone(now, timezone);
  const startedAt = isoInZone(now, timezone);
  const finishedAt = isoInZone(nowDate(options.now), timezone);
  const runId = `${day}-daily`;
  const fail = async (exitCode: number, message: string, counts: Record<string, number> = {}): Promise<DailyResult> => {
    await appendRun(project, { run_id: runId, job: "daily", started_at: startedAt, finished_at: finishedAt,
      status: "failed", counts, errors: [message] });
    return { exitCode, status: "failed", counts, errors: [message] };
  };

  if (!snapshot.length) return fail(EXIT.SOURCE_FAILED, "Feed 快照为空，未写入数据。");
  const overrides = site.crawl?.overrides ?? {};
  const snapBy = new Map<string, DailySnapshot>();
  for (const raw of snapshot) {
    const row = { ...raw, ...(overrides[raw.sku] ?? {}) } as DailySnapshot;
    row.sku = String(row.sku ?? "");
    row.stock_status = isStockStatus(row.stock_status) ? row.stock_status : "unknown";
    const category = categoryFor(site, row.sku, row);
    row.category = category.category;
    row.categories = category.categories;
    if (category.source) row.category_source = category.source;
    else if (site.categories) row.category_source = "none";
    else delete row.category_source;
    snapBy.set(row.sku, row);
  }

  const skuRows = await readJsonl(path.join(project, PATHS.skus));
  const latestRows = await readJsonl(path.join(project, PATHS.inventoryLatest));
  const skus = new Map(skuRows.map((row) => [String(row.sku), row]));
  const latest = new Map(latestRows.map((row) => [String(row.sku), row]));
  const events: JsonRecord[] = [];
  const baseline = skus.size === 0;
  const addEvent = (sku: string, type: EventType, from: unknown, to: unknown, source: JsonRecord) => {
    if (baseline) return;
    events.push({ date: day, sku, type, from, to, category: source.category ?? null, title: eventLabel(source) });
  };

  const active = new Set([...skus].filter(([, row]) => row.status === "active").map(([sku]) => sku));
  const gone = [...active].filter((sku) => !snapBy.has(sku)).sort(compareKeys);
  const previousRunDate = [...active].map((sku) => String(skus.get(sku)?.last_seen ?? "")).sort(compareKeys).at(-1);
  const seenLast = [...active].filter((sku) => skus.get(sku)?.last_seen === previousRunDate);
  const newlyGone = gone.filter((sku) => seenLast.includes(sku));
  const ratio = options.maxRemovedRatio ?? site.crawl?.max_removed_ratio ?? 0.1;
  if (seenLast.length && newlyGone.length / seenLast.length > ratio && !options.force) {
    const message = `本次有 ${newlyGone.length}/${seenLast.length} 个 SKU 从数据源消失，超过 ${(ratio * 100).toFixed(0)}% 保护阈值，疑似抓取/feed 不完整`;
    const result = await fail(EXIT.GUARD_ABORTED, message, { snapshot: snapBy.size, missing: gone.length });
    result.errors = [`${message}。确认无误后加 --force 重跑。`];
    return result;
  }

  for (const [sku, row] of snapBy) {
    const old = skus.get(sku);
    const rowForCatalog: JsonRecord = {};
    for (const key of TRACKED) {
      if (key === "category_source" && !site.categories) continue;
      rowForCatalog[key] = row[key] ?? null;
    }
    rowForCatalog.categories = Array.isArray(rowForCatalog.categories) && rowForCatalog.categories.length
      ? rowForCatalog.categories : rowForCatalog.category ? [rowForCatalog.category] : [];
    if (!old) {
      skus.set(sku, { sku, ...rowForCatalog, status: "active", first_seen: day, last_seen: day, updated_at: day });
      addEvent(sku, "new_sku", null, row.price ?? null, row);
      continue;
    }
    if (old.status === "removed") addEvent(sku, "restored_sku", "removed", "active", row);
    if (old.price !== null && old.price !== undefined && old.price !== rowForCatalog.price) {
      addEvent(sku, "price_change", old.price, rowForCatalog.price, row);
    }
    const changed = TRACKED.some((key) => key === "category_source" && !site.categories ? false : !equalValue(old[key], rowForCatalog[key])) || old.status !== "active";
    Object.assign(old, rowForCatalog, { status: "active", last_seen: day });
    if (changed) old.updated_at = day;
  }

  const missingAs = site.crawl?.missing_as ?? "removed";
  const removedAfter = site.crawl?.missing_removed_after_days ?? 30;
  for (const sku of gone) {
    const row = skus.get(sku)!;
    if (missingAs === "out_of_stock") {
      const idle = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${String(row.last_seen)}T00:00:00Z`)) / 86_400_000;
      if (idle < removedAfter) {
        const current = latest.get(sku);
        if (current && current.stock_status !== "out_of_stock") {
          addEvent(sku, "stock_change", current.stock_status, "out_of_stock", row);
          current.stock_status = "out_of_stock";
          current.since = day;
        }
        if (current) { current.qty = null; current.checked_at = startedAt; }
        continue;
      }
    }
    row.status = "removed";
    row.updated_at = day;
    addEvent(sku, "removed_sku", "active", "removed", row);
    latest.delete(sku);
  }

  for (const [sku, row] of snapBy) {
    const stockStatus = row.stock_status as StockStatus;
    const current = latest.get(sku);
    if (!current) {
      latest.set(sku, { sku, stock_status: stockStatus, qty: row.qty ?? null, since: day, checked_at: startedAt });
      continue;
    }
    if (current.stock_status !== stockStatus) {
      addEvent(sku, "stock_change", current.stock_status, stockStatus, row);
      current.since = day;
    }
    Object.assign(current, { stock_status: stockStatus, qty: row.qty ?? null, checked_at: startedAt });
  }

  const aggregate = new Map<string, StockCounts>();
  for (const [sku, row] of skus) {
    if (row.status !== "active") continue;
    const status = isStockStatus(latest.get(sku)?.stock_status) ? latest.get(sku)!.stock_status as StockStatus : "unknown";
    addCounts(aggregate, String(row.category || "uncategorized"), status);
    addCounts(aggregate, "_all", status);
  }
  const summaryPath = path.join(project, PATHS.dailySummary);
  const oldSummary = await readCsv(summaryPath);
  const summaryWithoutCurrent = oldSummary.filter((row) => row.date !== day);
  const previousDate = summaryWithoutCurrent.map((row) => String(row.date ?? "")).sort(compareKeys).at(-1);
  const previous = new Map(summaryWithoutCurrent.filter((row) => row.date === previousDate).map((row) => [String(row.category), row]));
  const summary: Record<string, unknown>[] = [...summaryWithoutCurrent];
  for (const [category, count] of aggregate) summary.push({ date: day, category, ...count });

  const eventCount = (type: string) => events.filter((event) => event.type === type).length;
  const restock = events.filter((event) => event.type === "stock_change" && event.to === "in_stock").length;
  const oos = events.filter((event) => event.type === "stock_change" && event.to === "out_of_stock").length;
  const all = aggregate.get("_all") ?? emptyCounts();
  const counts = {
    snapshot: snapBy.size,
    active: [...skus.values()].filter((row) => row.status === "active").length,
    restock,
    out_of_stock: oos,
    price_change: eventCount("price_change"),
    new_sku: eventCount("new_sku"),
    removed_sku: eventCount("removed_sku"),
    unknown: all.unknown,
  };
  const status: DailyStatus = counts.unknown > 0.05 * Math.max(counts.active, 1) ? "partial" : "ok";
  const errors = status === "partial" ? [`unknown 库存占比过高: ${counts.unknown}/${counts.active}，请检查 feed 的 availability 字段或 stock_rules`] : [];
  const report = renderReport(site, day, aggregate, previous, events, skus, latest);

  await writeJsonl(path.join(project, PATHS.skus), [...skus.values()], "sku");
  await writeJsonl(path.join(project, PATHS.inventoryLatest), [...latest.values()], "inventory_latest");
  const eventPath = path.join(project, eventsFile(day.slice(0, 7)));
  const existingEvents = await readJsonl(eventPath);
  const eventKeys = new Set(existingEvents.map((event) => [event.date, event.sku, event.type].join("\u0000")));
  const appended = events.filter((event) => {
    const key = [event.date, event.sku, event.type].join("\u0000");
    if (eventKeys.has(key)) return false;
    eventKeys.add(key);
    return true;
  });
  await writeJsonl(eventPath, [...existingEvents, ...appended], "inventory_event");
  await writeCsv(summaryPath, summary, CSV_HEADERS.dailySummary, ["date", "category"]);
  await mkdir(path.join(project, PATHS.dailyReportsDir), { recursive: true });
  await atomicWrite(path.join(project, dailyReportFile(day)), report);
  await appendRun(project, { run_id: runId, job: "daily", started_at: startedAt, finished_at: finishedAt,
    status, counts, errors });
  return { exitCode: EXIT.OK, status, counts, errors };
}

/** 与 CLI/Job 入口共用：读取磁盘 JSONL 快照后执行 daily。 */
export async function runDailyFromFile(project: string, snapshotPath: string, options: DailyOptions = {}): Promise<DailyResult> {
  const rows = await readJsonl(snapshotPath);
  return runDaily(project, rows as DailySnapshot[], options);
}
