import { createHash } from "node:crypto";
import {
  SEO_RULE_LABELS,
  type EdmCandidate,
  type InventoryEvent,
  type InventoryLatest,
  type ISODateTime,
  type PathKey,
  type RunLog,
  type SeoIssue,
  type Severity,
  type SiteConfig,
  type SkuRecord,
  type TodoRuleFinding,
  type TodoRuleScanStatus,
  type TodoRuleScanSummary,
  type TodoRuleSourceReference,
} from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { groupSkuIds, SkuGroupingRuleError } from "../inventory/sku-grouping";

export interface TodoRuleSnapshot<T> {
  status: TodoRuleScanStatus;
  /** Timestamp supplied by the reader for this exact source snapshot; never inferred here. */
  collected_at: ISODateTime | null;
  rows: readonly T[];
}

export interface TodoRuleEdmCandidate {
  candidate: Pick<EdmCandidate, "sku" | "stock_status" | "exclude_edm" | "image_url" | "image_source">;
  /** Provenance for the already-filtered, promotable EDM row. */
  sources: readonly TodoRuleSourceReference[];
}

export interface TodoRuleGenerationInput {
  /** Null is allowed only when every source is not_run. */
  observed_at: ISODateTime | null;
  seo_issues: TodoRuleSnapshot<Pick<SeoIssue, "url" | "rule" | "severity" | "detail" | "status">>;
  skus: TodoRuleSnapshot<Pick<SkuRecord, "sku" | "status" | "last_seen">>;
  inventory_latest: TodoRuleSnapshot<Pick<InventoryLatest, "sku" | "stock_status">>;
  inventory_events: TodoRuleSnapshot<Pick<InventoryEvent, "date" | "sku" | "type">>;
  site: TodoRuleSnapshot<Pick<SiteConfig, "sku_grouping">>;
  edm_candidates: TodoRuleSnapshot<TodoRuleEdmCandidate>;
  runs: TodoRuleSnapshot<Pick<RunLog, "run_id" | "job" | "started_at" | "finished_at" | "status">>;
}

export interface TodoRuleGenerationResult {
  findings: TodoRuleFinding[];
  scan: TodoRuleScanSummary;
}

const DAILY_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const WEEKLY_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

const SOURCE_SNAPSHOTS = [
  "seo_issues",
  "skus",
  "inventory_latest",
  "inventory_events",
  "site",
  "edm_candidates",
  "runs",
] as const;

type SourceSnapshotKey = (typeof SOURCE_SNAPSHOTS)[number];
type FindingDraft = Omit<TodoRuleFinding, "dedupe_key" | "sources"> & {
  sources: readonly TodoRuleSourceReference[];
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, mid: 1, low: 2 };

function isIsoDateTime(value: string | null): value is ISODateTime {
  return (
    value !== null &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function sourceRef(path: PathKey, recordKey: string, collectedAt: string | null): TodoRuleSourceReference | null {
  if (!recordKey || !isIsoDateTime(collectedAt)) return null;
  return { path, record_key: recordKey, collected_at: collectedAt };
}

function sourceFor<T>(path: PathKey, recordKey: string, snapshot: TodoRuleSnapshot<T>): TodoRuleSourceReference | null {
  return sourceRef(path, recordKey, snapshot.collected_at);
}

function sortedSources(
  sources: readonly TodoRuleSourceReference[],
): [TodoRuleSourceReference, ...TodoRuleSourceReference[]] | null {
  const unique = new Map<string, TodoRuleSourceReference>();
  for (const source of sources) {
    if (!isIsoDateTime(source.collected_at) || !source.record_key) continue;
    const key = `${source.path}\u0000${source.record_key}\u0000${source.collected_at}`;
    unique.set(key, source);
  }
  const ordered = [...unique.values()].sort(
    (left, right) =>
      compareKeys(left.path, right.path) ||
      compareKeys(left.record_key, right.record_key) ||
      compareKeys(left.collected_at, right.collected_at),
  );
  const first = ordered[0];
  return first ? [first, ...ordered.slice(1)] : null;
}

function makeDedupeKey(ruleId: string, subjectKind: string, subjectKey: string): string {
  const identity = JSON.stringify([ruleId, subjectKind, subjectKey]);
  return `todo:v1:${createHash("sha256").update(identity).digest("hex")}`;
}

function compareIso(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return compareKeys(left, right);
}

function combineFinding(current: TodoRuleFinding, incoming: TodoRuleFinding): TodoRuleFinding {
  const sources = sortedSources([...current.sources, ...incoming.sources]);
  const details = [current.detail, incoming.detail].filter((detail): detail is string => Boolean(detail?.trim()));
  const uniqueDetails = [...new Set(details)].sort(compareKeys);
  const currentSeverity = current.severity;
  const incomingSeverity = incoming.severity;
  const severity =
    currentSeverity && incomingSeverity
      ? SEVERITY_ORDER[currentSeverity] <= SEVERITY_ORDER[incomingSeverity]
        ? currentSeverity
        : incomingSeverity
      : (currentSeverity ?? incomingSeverity);
  return {
    ...current,
    ...(severity ? { severity } : {}),
    ...(uniqueDetails.length ? { detail: uniqueDetails.join("；") } : {}),
    sources: sources ?? current.sources,
    first_seen_at:
      compareIso(current.first_seen_at, incoming.first_seen_at) <= 0 ? current.first_seen_at : incoming.first_seen_at,
    last_seen_at:
      compareIso(current.last_seen_at, incoming.last_seen_at) >= 0 ? current.last_seen_at : incoming.last_seen_at,
  };
}

function makeFinding(draft: FindingDraft): TodoRuleFinding | null {
  const sources = sortedSources(draft.sources);
  if (!sources) return null;
  return {
    ...draft,
    dedupe_key: makeDedupeKey(draft.rule_id, draft.subject.kind, draft.subject.key),
    sources,
  };
}

function uniqueBySku<T extends { sku: string }>(
  rows: readonly T[],
): { bySku: Map<string, T>; duplicates: Set<string> } {
  const bySku = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (bySku.has(row.sku)) duplicates.add(row.sku);
    else bySku.set(row.sku, row);
  }
  for (const duplicate of duplicates) bySku.delete(duplicate);
  return { bySku, duplicates };
}

type TodoRun = Pick<RunLog, "run_id" | "job" | "started_at" | "finished_at" | "status">;

function latestRunByJob(rows: readonly TodoRun[], job: TodoRun["job"]): TodoRun | null {
  const matching = rows
    .filter((row) => row.job === job)
    .sort((left, right) => compareIso(right.started_at, left.started_at) || compareKeys(left.run_id, right.run_id));
  return matching[0] ?? null;
}

function latestSuccessfulRunByJob(rows: readonly TodoRun[], job: TodoRun["job"]): TodoRun | null {
  const matching = rows
    .filter((row) => row.job === job && row.status === "ok" && row.finished_at !== null)
    .sort(
      (left, right) =>
        compareIso(right.finished_at ?? "", left.finished_at ?? "") || compareKeys(left.run_id, right.run_id),
    );
  return matching[0] ?? null;
}

function scanStatus(
  input: TodoRuleGenerationInput,
  hasUntrustedEvidence: boolean,
  ruleExecutionFailed: boolean,
): TodoRuleScanStatus {
  const statuses = SOURCE_SNAPSHOTS.map((key) => input[key].status);
  if (statuses.every((status) => status === "not_run")) return "not_run";
  if (ruleExecutionFailed || statuses.some((status) => status === "failed")) return "failed";
  if (hasUntrustedEvidence || statuses.some((status) => status !== "complete")) return "partial";
  if (SOURCE_SNAPSHOTS.some((key) => !isIsoDateTime(input[key].collected_at))) return "partial";
  return "complete";
}

/** Generates deterministic rule findings only; it never reads or mutates manual todo state. */
export function generateTodoRuleFindings(input: TodoRuleGenerationInput): TodoRuleGenerationResult {
  const allNotRun = SOURCE_SNAPSHOTS.every((key) => input[key].status === "not_run");
  if (allNotRun) return { findings: [], scan: { status: "not_run", evaluated_at: null } };
  if (!isIsoDateTime(input.observed_at))
    throw new TypeError("observed_at must be an ISO 8601 timestamp with timezone.");

  const observedAt = input.observed_at;
  let hasUntrustedEvidence = false;
  let ruleExecutionFailed = false;
  const findingByKey = new Map<string, TodoRuleFinding>();

  const add = (draft: FindingDraft): void => {
    const finding = makeFinding(draft);
    if (!finding) {
      hasUntrustedEvidence = true;
      return;
    }
    const existing = findingByKey.get(finding.dedupe_key);
    findingByKey.set(finding.dedupe_key, existing ? combineFinding(existing, finding) : finding);
  };

  if (input.seo_issues.status === "complete" || input.seo_issues.status === "partial") {
    for (const issue of input.seo_issues.rows) {
      if (issue.status !== "open") continue;
      const ruleId = `seo.issue.${issue.rule}`;
      const url = issue.url.trim();
      const source = sourceFor("seoIssues", `${url}\u0000${issue.rule}`, input.seo_issues);
      add({
        rule_id: ruleId,
        subject: { kind: "page", key: url },
        title: `SEO：${SEO_RULE_LABELS[issue.rule]}`,
        detail: issue.detail,
        severity: issue.severity,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        sources: source ? [source] : [],
      });
    }
  }

  const skuRows = input.skus.status === "complete" || input.skus.status === "partial" ? input.skus.rows : [];
  const activeSkus = skuRows.filter((row) => row.status === "active");
  const uniqueSkus = uniqueBySku(activeSkus);
  if (uniqueSkus.duplicates.size > 0) hasUntrustedEvidence = true;

  const latestRows =
    input.inventory_latest.status === "complete" || input.inventory_latest.status === "partial"
      ? input.inventory_latest.rows
      : [];
  const uniqueLatest = uniqueBySku(latestRows);
  if (uniqueLatest.duplicates.size > 0) hasUntrustedEvidence = true;
  if (
    skuRows.length > 0 &&
    (input.skus.status === "complete" || input.skus.status === "partial") &&
    (input.inventory_latest.status === "complete" || input.inventory_latest.status === "partial")
  ) {
    for (const sku of uniqueSkus.bySku.values()) {
      const latest = uniqueLatest.bySku.get(sku.sku);
      if (!latest) {
        hasUntrustedEvidence = true;
        continue;
      }
      if (latest.stock_status !== "unknown") continue;
      const skuSource = sourceFor("skus", sku.sku, input.skus);
      const stockSource = sourceFor("inventoryLatest", sku.sku, input.inventory_latest);
      add({
        rule_id: "inventory.unknown_stock",
        subject: { kind: "sku", key: sku.sku, label: sku.sku },
        title: `库存状态未知：${sku.sku}`,
        severity: "mid",
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        sources: [skuSource, stockSource].filter((source): source is TodoRuleSourceReference => source !== null),
      });
    }
  }

  if (input.inventory_events.status === "complete" || input.inventory_events.status === "partial") {
    const anomalyBySku = new Map<string, TodoRuleGenerationInput["inventory_events"]["rows"][number]>();
    for (const event of input.inventory_events.rows) {
      if (event.type !== "feed_anomaly") continue;
      const current = anomalyBySku.get(event.sku);
      if (!current || compareKeys(event.date, current.date) > 0) anomalyBySku.set(event.sku, event);
    }
    for (const [sku, event] of anomalyBySku) {
      const catalogRow = uniqueSkus.bySku.get(sku);
      if (catalogRow?.status === "active" && compareKeys(catalogRow.last_seen, event.date) > 0) continue;
      const eventKey = `${event.date}\u0000${sku}\u0000feed_anomaly`;
      const eventSource = sourceFor("eventsDir", eventKey, input.inventory_events);
      const skuSource = catalogRow ? sourceFor("skus", sku, input.skus) : null;
      add({
        rule_id: "inventory.feed_anomaly",
        subject: { kind: "sku", key: sku, label: sku },
        title: `Feed 缺席但页面仍显示有货：${sku}`,
        severity: "high",
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        sources: [eventSource, skuSource].filter((source): source is TodoRuleSourceReference => source !== null),
      });
    }
  }

  const siteSnapshotUsable = input.site.status === "complete" || input.site.status === "partial";
  const siteConfig = input.site.rows.length === 1 ? input.site.rows[0] : undefined;
  if (siteSnapshotUsable && !siteConfig) hasUntrustedEvidence = true;
  if (
    siteSnapshotUsable &&
    siteConfig?.sku_grouping?.enabled &&
    (input.skus.status === "complete" || input.skus.status === "partial")
  ) {
    try {
      const grouping = groupSkuIds([...uniqueSkus.bySku.keys()], siteConfig.sku_grouping.rule);
      for (const collision of grouping.collisions) {
        const skuSources = [collision.parent, ...collision.children]
          .map((sku) => sourceFor("skus", sku, input.skus))
          .filter((source): source is TodoRuleSourceReference => source !== null);
        const configSource = sourceFor("site", "sku_grouping", input.site);
        if (configSource) skuSources.push(configSource);
        add({
          rule_id: "inventory.sku_grouping_collision",
          subject: { kind: "sku_group", key: collision.parent, label: collision.parent },
          title: `SKU 分组碰撞：${collision.parent}`,
          detail: `候选父 SKU 同时存在于 feed；子 SKU：${collision.children.join("、")}`,
          severity: "mid",
          first_seen_at: observedAt,
          last_seen_at: observedAt,
          sources: skuSources,
        });
      }
    } catch (error) {
      if (!(error instanceof SkuGroupingRuleError)) throw error;
      ruleExecutionFailed = true;
    }
  }

  if (input.edm_candidates.status === "complete" || input.edm_candidates.status === "partial") {
    const rowsBySku = new Map<string, TodoRuleEdmCandidate>();
    const duplicateSkus = new Set<string>();
    for (const row of input.edm_candidates.rows) {
      const sku = row.candidate.sku;
      if (rowsBySku.has(sku)) duplicateSkus.add(sku);
      else rowsBySku.set(sku, row);
    }
    if (duplicateSkus.size > 0) hasUntrustedEvidence = true;
    for (const sku of duplicateSkus) rowsBySku.delete(sku);
    for (const row of rowsBySku.values()) {
      const candidate = row.candidate;
      if (candidate.stock_status !== "in_stock" || candidate.exclude_edm) continue;
      const hasImageUrl = Boolean(candidate.image_url?.trim());
      if (candidate.image_source !== "none" && hasImageUrl) continue;
      if (candidate.image_source !== "none" || hasImageUrl) {
        hasUntrustedEvidence = true;
        continue;
      }
      add({
        rule_id: "edm.promotable_missing_usable_image",
        subject: { kind: "sku", key: candidate.sku, label: candidate.sku },
        title: `可推广商品缺少可用图片：${candidate.sku}`,
        severity: "mid",
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        sources: row.sources,
      });
    }
  }

  if (input.runs.status === "complete" || input.runs.status === "partial") {
    for (const job of ["daily", "weekly"] as const) {
      const latest = latestRunByJob(input.runs.rows, job);
      if (latest && (latest.status === "failed" || latest.status === "partial")) {
        const source = sourceFor("runs", latest.run_id, input.runs);
        add({
          rule_id: "sync.latest_run_failed",
          subject: { kind: "job", key: job, label: job },
          title: `${job === "daily" ? "每日" : "每周"}同步${latest.status === "failed" ? "失败" : "部分失败"}`,
          detail: `最近一次 ${job} 运行状态为 ${latest.status}。`,
          severity: latest.status === "failed" ? "high" : "mid",
          first_seen_at: latest.started_at,
          last_seen_at: observedAt,
          sources: source ? [source] : [],
        });
      }
      const success = latestSuccessfulRunByJob(input.runs.rows, job);
      if (!success?.finished_at) continue;
      const staleAfterMs = job === "daily" ? DAILY_STALE_AFTER_MS : WEEKLY_STALE_AFTER_MS;
      const elapsedMs = Date.parse(observedAt) - Date.parse(success.finished_at);
      if (elapsedMs <= staleAfterMs) continue;
      const source = sourceFor("runs", success.run_id, input.runs);
      add({
        rule_id: "sync.data_stale",
        subject: { kind: "job", key: job, label: job },
        title: `${job === "daily" ? "每日" : "每周"}数据已过期`,
        detail: `最近一次成功运行于 ${success.finished_at}。`,
        severity: "mid",
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        sources: source ? [source] : [],
      });
    }
  }

  const status = scanStatus(input, hasUntrustedEvidence, ruleExecutionFailed);
  return {
    findings: [...findingByKey.values()].sort((left, right) => compareKeys(left.dedupe_key, right.dedupe_key)),
    scan: { status, evaluated_at: observedAt },
  };
}
