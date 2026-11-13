import { readFile } from "node:fs/promises";
import type { GscDateRange, GscMissingRange, GscSyncInput, GscSyncMetadata, GscSyncResult } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";

export interface GscAnalyticsRow {
  property: string;
  date: string;
  page: string;
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  collected_at: string;
}

interface PendingDates { property: string; dates: string[] }
interface History { version: 1; rows: GscAnalyticsRow[]; pending_dates?: PendingDates[] }

export interface GscAnalyticsOptions {
  /** Resolved by the project-layout integration; no credentials are written to this file. */
  historyPath: string;
  property: string | null;
  accessToken: string;
  now?: Date;
  /** Internal test seam for a loopback service. */
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

const API_BASE = "https://www.googleapis.com/webmasters/v3";
const PAGE_SIZE = 25_000;
const DAY = 86_400_000;

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function isRow(value: unknown): value is GscAnalyticsRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.property === "string" && row.property.length > 0 && validDate(row.date)
    && typeof row.page === "string" && typeof row.query === "string"
    && typeof row.collected_at === "string" && Number.isFinite(Date.parse(row.collected_at))
    && [row.impressions, row.clicks, row.ctr, row.position].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
}

async function readHistory(file: string): Promise<History> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("rows" in data)
      || !Array.isArray(data.rows) || !data.rows.every(isRow)) throw new Error("invalid history");
    const pending = "pending_dates" in data ? data.pending_dates : undefined;
    if (pending !== undefined && (!Array.isArray(pending) || !pending.every((entry: unknown) =>
      !!entry && typeof entry === "object" && "property" in entry && typeof entry.property === "string"
      && "dates" in entry && Array.isArray(entry.dates) && entry.dates.every(validDate)))) throw new Error("invalid pending dates");
    return { version: 1, rows: data.rows, pending_dates: pending as PendingDates[] | undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rows: [] };
    throw error;
  }
}

function key(row: GscAnalyticsRow): string { return JSON.stringify([row.property, row.date, row.page, row.query]); }

function gaps(start: string, end: string, available: Set<string>): GscMissingRange[] {
  const result: GscMissingRange[] = [];
  for (let date = start; date <= end; date = shift(date, 1)) {
    if (!available.has(date)) result.push({ start_date: date, end_date: date, reason: "no_rows" });
  }
  return result;
}

/** Queries finalized Search Console data and upserts only returned, valid rows into local history. */
export async function syncSearchAnalytics(input: GscSyncInput, options: GscAnalyticsOptions): Promise<GscSyncResult> {
  const now = options.now ?? new Date();
  const requestedAt = now.toISOString();
  const property = options.property?.trim() || null;
  const metadata: GscSyncMetadata = {
    data_source: "google_search_console", property_site_url: property, requested_at: requestedAt,
    collected_at: null, data_through: null, requested_range: null, missing_ranges: [],
    missing_fields: [], quality: "partial", anomalies: [],
  };
  const fail = (state: "blocked" | "failed", code: string, message: string): GscSyncResult => ({
    state, mode: input.mode, records_received: 0, records_written: 0, history_effect: "preserved",
    metadata: { ...metadata, quality: "partial", anomalies: [{ code, severity: "warning", message }] }, error: { code, message },
  });
  if (!property) return fail("blocked", "GSC_PROPERTY_REQUIRED", "请先选择 Search Console 属性。");
  if (!options.accessToken) return fail("blocked", "GSC_AUTH_REQUIRED", "请先连接 Google 账户。");

  let history: History;
  try { history = await readHistory(options.historyPath); }
  catch { return fail("failed", "GSC_HISTORY_UNREADABLE", "无法读取本地历史数据，原文件已保留。"); }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const existingDates = history.rows.filter((row) => row.property === property).map((row) => row.date).sort();
  const lastDate = existingDates.at(-1);
  const pendingDates = history.pending_dates?.filter((entry) => entry.property === property).flatMap((entry) => entry.dates) ?? [];
  // Older history files did not record gaps; rescan their last 90 days once.
  const nextDate = lastDate && history.pending_dates === undefined ? shift(lastDate, -89) : lastDate && shift(lastDate, 1);
  const availabilityStart = input.mode === "incremental" && nextDate
    ? [nextDate, ...pendingDates].sort()[0]! : shift(today, -119);
  if (availabilityStart > today) return { state: "complete", mode: input.mode, records_received: 0, records_written: 0, history_effect: "merged", metadata: { ...metadata, data_through: lastDate ?? null, quality: "complete" } };

  const request = async (range: GscDateRange, dimensions: string[], startRow = 0): Promise<unknown[]> => {
    const response = await (options.fetch ?? globalThis.fetch)(`${options.apiBaseUrl ?? API_BASE}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: "POST", headers: { Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: range.start_date, endDate: range.end_date, dimensions, rowLimit: PAGE_SIZE, startRow, dataState: "final" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Object.assign(new Error("request failed"), { status: response.status });
    const result: unknown = await response.json();
    if (!result || typeof result !== "object") throw new Error("invalid response");
    if (!("rows" in result)) return [];
    if (!Array.isArray(result.rows)) throw new Error("invalid rows");
    return result.rows;
  };

  try {
    const availabilityRange = { start_date: availabilityStart, end_date: today };
    metadata.requested_range = availabilityRange;
    const datesRaw = await request(availabilityRange, ["date"]);
    const parseDates = (items: unknown[]) => items.map((row) => {
      if (!row || typeof row !== "object" || !("keys" in row) || !Array.isArray(row.keys) || !validDate(row.keys[0])) throw new Error("invalid dates");
      return row.keys[0];
    });
    const dates = parseDates(datesRaw).filter((date) => date >= availabilityStart && date <= today).sort();
    const through = dates.at(-1);
    if (!through) {
      metadata.missing_ranges = [{ ...availabilityRange, reason: "not_yet_available" }];
      return fail("blocked", "GSC_NO_DATA", "所请求日期暂无可用数据，历史数据保持不变。");
    }
    const start = input.mode === "incremental" && lastDate ? availabilityStart : shift(through, -89);
    const range = { start_date: start, end_date: through };
    metadata.requested_range = range;
    metadata.data_through = through;
    const rangeDates = start < availabilityStart ? parseDates(await request(range, ["date"])) : dates;
    metadata.missing_ranges = gaps(start, through, new Set(rangeDates));
    const received: GscAnalyticsRow[] = [];
    for (let startRow = 0; ; startRow += PAGE_SIZE) {
      const batch = await request(range, ["date", "page", "query"], startRow);
      for (const raw of batch) {
        if (!raw || typeof raw !== "object" || !("keys" in raw) || !Array.isArray(raw.keys) || raw.keys.length !== 3) throw new Error("invalid row");
        const item = raw as Record<string, unknown>;
        const [date, page, query] = raw.keys;
        const candidate = { property, date, page, query, impressions: item.impressions, clicks: item.clicks, ctr: item.ctr, position: item.position, collected_at: requestedAt };
        if (!isRow(candidate) || candidate.date < start || candidate.date > through) throw new Error("invalid row");
        received.push(candidate);
      }
      if (batch.length < PAGE_SIZE) break;
    }
    if (received.length === 0) {
      metadata.missing_fields = ["search_analytics.rows"];
      return fail("blocked", "GSC_NO_ROWS", "没有返回页面与关键词数据，历史数据保持不变。");
    }
    const returnedDates = new Set(received.map((row) => row.date));
    for (const date of new Set(rangeDates)) {
      if (date >= start && date <= through && !returnedDates.has(date)) {
        metadata.missing_ranges.push({ start_date: date, end_date: date, reason: "not_returned" });
      }
    }
    const countByDate = new Map<string, number>();
    for (const row of received) countByDate.set(row.date, (countByDate.get(row.date) ?? 0) + 1);
    if ([...countByDate.values()].some((count) => count >= 50_000)) {
      metadata.missing_fields.push("search_analytics.possibly_truncated");
      metadata.anomalies.push({ code: "GSC_ROW_LIMIT", severity: "warning", message: "单日数据达到接口上限，结果可能不完整。" });
    }
    const rows = new Map(history.rows.map((row) => [key(row), row]));
    for (const row of received) rows.set(key(row), row);
    const merged = [...rows.values()].sort((a, b) => compareKeys(key(a), key(b)));
    const remaining = pendingDates.filter((date) => date < start || date > through);
    for (const gap of metadata.missing_ranges) {
      for (let date = gap.start_date; date <= gap.end_date; date = shift(date, 1)) remaining.push(date);
    }
    const pending = (history.pending_dates ?? []).filter((entry) => entry.property !== property);
    if (remaining.length) pending.push({ property, dates: [...new Set(remaining)].sort() });
    await atomicWrite(options.historyPath, `${JSON.stringify({ version: 1, rows: merged, pending_dates: pending })}\n`);
    metadata.collected_at = requestedAt;
    metadata.quality = metadata.missing_ranges.length || metadata.missing_fields.length ? "partial" : "complete";
    return { state: metadata.quality === "complete" ? "complete" : "partial", mode: input.mode, records_received: received.length, records_written: received.length, history_effect: "merged", metadata };
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? error.status : undefined;
    return fail("failed", status === 429 || status === 403 ? "GSC_QUOTA_OR_PERMISSION" : "GSC_SYNC_FAILED", "Search Console 同步失败，已有历史数据保持不变。");
  }
}
