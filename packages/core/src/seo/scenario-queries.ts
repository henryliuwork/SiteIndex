import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  RunLog,
  ScenarioAnomaly,
  ScenarioQueryResult,
  ScenarioResultMetadata,
  ScenarioSource,
  SeoInternalLinkContext,
  SeoIssue,
  SeoLink,
  SeoPage,
  SeoPageBrief,
  PathKey,
} from "@siteindex/shared";
import { SEO_RULE_LABELS } from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { parseJsonl, type JsonRecord } from "../io/jsonl";
import { pathsForProject } from "../io/project-layout";

// SEO runs weekly; after two missed weekly cycles the index is marked potentially stale.
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

type ScenarioField = "seo.pages" | "seo.issues" | "seo.links" | "logs.runs";
type SourceState = "ok" | "missing" | "invalid" | "unreadable";

interface ScenarioRows<T> {
  field: ScenarioField;
  source: ScenarioSource;
  state: SourceState;
  rows: T[] | null;
}

interface ScenarioResultExtras {
  missingFields?: readonly string[];
  anomalies?: readonly ScenarioAnomaly[];
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSeoPage(value: JsonRecord): value is JsonRecord & SeoPage {
  return typeof value.url === "string"
    && (value.page_type === "home" || value.page_type === "collection" || value.page_type === "product"
      || value.page_type === "blog" || value.page_type === "page" || value.page_type === "other")
    && typeof value.status_code === "number"
    && isNullableString(value.title)
    && typeof value.title_length === "number"
    && isNullableString(value.meta_description)
    && typeof value.description_length === "number"
    && isNullableString(value.h1)
    && typeof value.h1_count === "number"
    && isNullableString(value.canonical)
    && (value.canonical_status === "self" || value.canonical_status === "other" || value.canonical_status === "missing")
    && isNullableString(value.robots_meta)
    && isNullableString(value.x_robots_tag)
    && typeof value.indexable === "boolean"
    && typeof value.in_sitemap === "boolean"
    && isStringArray(value.schema_types)
    && (value.word_count === null || typeof value.word_count === "number")
    && typeof value.last_crawled === "string";
}

function isSeoIssue(value: JsonRecord): value is JsonRecord & SeoIssue {
  return typeof value.url === "string"
    && typeof value.rule === "string"
    && Object.hasOwn(SEO_RULE_LABELS, value.rule)
    && (value.severity === "high" || value.severity === "mid" || value.severity === "low")
    && typeof value.detail === "string"
    && (value.status === "open" || value.status === "fixed" || value.status === "ignored")
    && typeof value.first_seen === "string"
    && typeof value.last_seen === "string";
}

function isSeoLink(value: JsonRecord): value is JsonRecord & SeoLink {
  return typeof value.from === "string"
    && typeof value.to === "string"
    && typeof value.anchor === "string"
    && (value.to_type === "product" || value.to_type === "collection" || value.to_type === "blog" || value.to_type === "page");
}

function isRunLog(value: JsonRecord): value is JsonRecord & RunLog {
  return typeof value.run_id === "string"
    && ["daily", "weekly", "monthly", "validate", "readme", "design", "index-check", "views", "init", "media"].includes(String(value.job))
    && validTimestamp(value.started_at)
    && (value.finished_at === null || validTimestamp(value.finished_at))
    && (value.status === "ok" || value.status === "partial" || value.status === "failed" || value.status === "skipped");
}

const FIELD_INFO: Record<ScenarioField, { relativePath: PathKey; label: string }> = {
  "seo.pages": { relativePath: "seoPages", label: "SEO 页面索引" },
  "seo.issues": { relativePath: "seoIssues", label: "SEO 问题索引" },
  "seo.links": { relativePath: "seoLinks", label: "SEO 内链索引" },
  "logs.runs": { relativePath: "runs", label: "Job 运行记录" },
};

async function readScenarioRows<T>(
  projectPath: string,
  field: ScenarioField,
  validator: (row: JsonRecord) => row is JsonRecord & T,
): Promise<ScenarioRows<T>> {
  const info = FIELD_INFO[field];
  const source: ScenarioSource = { kind: field, label: info.label };
  const paths = await pathsForProject(projectPath);
  const filePath = path.join(projectPath, paths[info.relativePath]);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      field,
      source,
      state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      rows: null,
    };
  }

  let parsed: JsonRecord[];
  try {
    parsed = parseJsonl(text, info.label);
  } catch {
    return { field, source, state: "invalid", rows: null };
  }
  if (!parsed.every(validator)) return { field, source, state: "invalid", rows: null };
  return { field, source, state: "ok", rows: parsed as unknown as T[] };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function anomaly(code: string, severity: ScenarioAnomaly["severity"], message: string, field?: string): ScenarioAnomaly {
  return { code, severity, message, ...(field ? { field } : {}) };
}

function buildMetadata(
  rows: readonly ScenarioRows<unknown>[],
  extras: ScenarioResultExtras = {},
  now = Date.now(),
): ScenarioResultMetadata {
  const missing = new Set(extras.missingFields ?? []);
  const anomalies: ScenarioAnomaly[] = [...(extras.anomalies ?? [])];
  for (const result of rows) {
    if (result.state === "ok") continue;
    missing.add(result.field);
    const info = FIELD_INFO[result.field];
    if (result.state === "missing") {
      anomalies.push(anomaly("SOURCE_MISSING", "warning", `${info.label}文件不存在。`, result.field));
    } else if (result.state === "invalid") {
      anomalies.push(anomaly("SOURCE_INVALID", "unreliable", `${info.label}包含无效 JSONL 记录，无法安全读取。`, result.field));
    } else {
      anomalies.push(anomaly("SOURCE_UNREADABLE", "unreliable", `${info.label}无法读取。`, result.field));
    }
  }

  const runSource = rows.find((result) => result.field === "logs.runs");
  let collectedAt: string | null = null;
  if (runSource?.state === "ok" && runSource.rows) {
    const weekly = (runSource.rows as RunLog[]).filter((run) => run.job === "weekly");
    if (!weekly.length) {
      missing.add("logs.runs.weekly");
      anomalies.push(anomaly("WEEKLY_RUN_MISSING", "warning", "没有 weekly 运行记录，无法确认 SEO 数据采集时间。", "logs.runs"));
    } else {
      const byStarted = [...weekly].sort((left, right) => {
        const timeOrder = Date.parse(right.started_at) - Date.parse(left.started_at);
        return Number.isNaN(timeOrder) || timeOrder === 0
          ? compareKeys(right.started_at, left.started_at)
          : timeOrder;
      });
      const latestAttempt = byStarted[0]!;
      if (latestAttempt.status !== "ok") {
        anomalies.push(anomaly("WEEKLY_LATEST_NOT_SUCCESSFUL", "warning", "最近一次 weekly 未完整成功，SEO 数据可能未全部更新。", "logs.runs"));
      }
      const successful = weekly
        .filter((run) => run.status === "ok" && validTimestamp(run.finished_at))
        .sort((left, right) => {
          const timeOrder = Date.parse(right.finished_at!) - Date.parse(left.finished_at!);
          return Number.isNaN(timeOrder) || timeOrder === 0
            ? compareKeys(right.started_at, left.started_at)
            : timeOrder;
        });
      if (successful.length) {
        collectedAt = successful[0]!.finished_at!;
        if (now - Date.parse(collectedAt) > STALE_AFTER_MS) {
          anomalies.push(anomaly("SEO_INDEX_STALE", "warning", "最近一次成功 weekly 已超过 14 天，当前 SEO 索引可能已过期。", "logs.runs"));
        }
      } else {
        missing.add("logs.runs.weekly_success");
        anomalies.push(anomaly("WEEKLY_COLLECTION_UNKNOWN", "warning", "没有成功完成的 weekly 运行记录，无法确认 SEO 数据采集时间。", "logs.runs"));
      }
      if (weekly.some((run) => run.status === "ok" && !validTimestamp(run.finished_at))) {
        anomalies.push(anomaly("WEEKLY_TIMESTAMP_INVALID", "warning", "weekly 运行记录缺少有效完成时间。", "logs.runs"));
      }
    }
  }

  const uniqueAnomalies = new Map<string, ScenarioAnomaly>();
  for (const item of anomalies) {
    const key = `${item.code}\u0000${item.field ?? ""}\u0000${item.message}`;
    uniqueAnomalies.set(key, item);
  }
  const sortedAnomalies = [...uniqueAnomalies.values()].sort((left, right) =>
    compareKeys(left.code, right.code) || compareKeys(left.field ?? "", right.field ?? "") || compareKeys(left.message, right.message));
  const missingFields = [...missing].sort(compareKeys);
  const quality = sortedAnomalies.some((item) => item.severity === "unreliable")
    ? "unreliable"
    : sortedAnomalies.length || missingFields.length ? "partial" : "complete";
  return {
    sources: rows.map((result) => result.source).sort((left, right) => compareKeys(left.kind, right.kind)),
    collected_at: collectedAt,
    missing_fields: missingFields,
    quality,
    anomalies: sortedAnomalies,
  };
}

function result<T>(
  data: T | null,
  rows: readonly ScenarioRows<unknown>[],
  extras?: ScenarioResultExtras,
): ScenarioQueryResult<T> {
  return { data, metadata: buildMetadata(rows, extras) };
}

function compareIssues(left: SeoIssue, right: SeoIssue): number {
  return compareKeys(left.url, right.url) || compareKeys(left.rule, right.rule) || compareKeys(left.status, right.status);
}

function compareLinks(left: SeoLink, right: SeoLink): number {
  return compareKeys(left.from, right.from) || compareKeys(left.to, right.to) || compareKeys(left.anchor, right.anchor);
}

function missingPage(): ScenarioAnomaly {
  return anomaly("PAGE_NOT_INDEXED", "warning", "该 URL 尚无已抓取的 SEO 页面记录。", "seo.pages.url");
}

export async function readSeoPageBrief(projectPath: string, url: string): Promise<ScenarioQueryResult<SeoPageBrief>> {
  const [pages, issues, links, runs] = await Promise.all([
    readScenarioRows(projectPath, "seo.pages", isSeoPage),
    readScenarioRows(projectPath, "seo.issues", isSeoIssue),
    readScenarioRows(projectPath, "seo.links", isSeoLink),
    readScenarioRows(projectPath, "logs.runs", isRunLog),
  ]);
  const page = pages.rows?.find((row) => row.url === url);
  if (!page) {
    const unavailable = pages.state === "ok" ? {
      missingFields: ["seo.pages.url"],
      anomalies: [missingPage()],
    } : undefined;
    return result<SeoPageBrief>(null, [pages, issues, links, runs], unavailable);
  }
  const allLinks = (links.rows ?? []).slice().sort(compareLinks);
  const data: SeoPageBrief = {
    page,
    issues: (issues.rows ?? []).filter((issue) => issue.url === url).sort(compareIssues),
    incoming_links: allLinks.filter((link) => link.to === url),
    outgoing_links: allLinks.filter((link) => link.from === url),
  };
  return result(data, [pages, issues, links, runs]);
}

export async function readSeoIssueCandidates(projectPath: string, url?: string): Promise<ScenarioQueryResult<SeoIssue[]>> {
  const [issues, runs] = await Promise.all([
    readScenarioRows(projectPath, "seo.issues", isSeoIssue),
    readScenarioRows(projectPath, "logs.runs", isRunLog),
  ]);
  const data = issues.rows
    ? issues.rows.filter((issue) => issue.status === "open" && (url === undefined || issue.url === url)).sort(compareIssues)
    : null;
  return result(data, [issues, runs]);
}

export async function readSeoInternalLinkContext(projectPath: string, url: string): Promise<ScenarioQueryResult<SeoInternalLinkContext>> {
  const [pages, links, runs] = await Promise.all([
    readScenarioRows(projectPath, "seo.pages", isSeoPage),
    readScenarioRows(projectPath, "seo.links", isSeoLink),
    readScenarioRows(projectPath, "logs.runs", isRunLog),
  ]);
  const page = pages.rows?.find((row) => row.url === url);
  if (!page) {
    const unavailable = pages.state === "ok" ? {
      missingFields: ["seo.pages.url"],
      anomalies: [missingPage()],
    } : undefined;
    return result<SeoInternalLinkContext>(null, [pages, links, runs], unavailable);
  }
  const pagesByUrl = new Map((pages.rows ?? []).map((row) => [row.url, row]));
  const allLinks = (links.rows ?? []).slice().sort(compareLinks);
  const incoming = allLinks.filter((link) => link.to === url).map((link) => ({ link, source_page: pagesByUrl.get(link.from) ?? null }));
  const outgoing = allLinks.filter((link) => link.from === url).map((link) => ({ link, target_page: pagesByUrl.get(link.to) ?? null }));
  const endpointsMissing = incoming.some((row) => row.source_page === null) || outgoing.some((row) => row.target_page === null);
  return result({ page, incoming_links: incoming, outgoing_links: outgoing }, [pages, links, runs], endpointsMissing ? {
    missingFields: ["seo.pages.link_endpoints"],
    anomalies: [anomaly("LINK_ENDPOINT_NOT_INDEXED", "warning", "部分站内链接的端点没有对应的 SEO 页面索引。", "seo.pages.link_endpoints")],
  } : undefined);
}
